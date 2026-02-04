Pebble.addEventListener('ready', function() {
    console.log("VibeCoder ready");
    var ws = new WebSocket('ws://localhost:8080');
    var sending = false;
    var pending = null;

    ws.onopen = function() {
        console.log("Bridge OK");
        // Request session list on connect
        ws.send(JSON.stringify({ type: 'list' }));
    };

    ws.onclose = function() {
        console.log("Bridge lost, retry 3s");
        setTimeout(function() { ws = new WebSocket('ws://localhost:8080'); }, 3000);
    };

    ws.onmessage = function(e) {
        var msg = JSON.parse(e.data);
        console.log("Bridge msg: " + msg.type);

        if (msg.type === 'menu') {
            // Send menu to watch: MENU:session1,session2,...
            var sessions = msg.sessions || [];
            pending = { "TERMINAL_DATA": "MENU:" + sessions.join(",") };
            trySend();
        }
        else if (msg.type === 'session_joined' || msg.type === 'session_created') {
            // Send session name to watch
            pending = { "TERMINAL_DATA": "SESSION:" + msg.name };
            trySend();
        }
        else if (msg.type === 'output') {
            var content = msg.content;
            if (content.length > 1900) content = content.substring(content.length - 1900);
            var nl = content.indexOf('\n');
            if (nl >= 0 && nl < 50) content = content.substring(nl + 1);
            var payload = { "TERMINAL_DATA": content };

            if (msg.prompt && msg.prompt.options) {
                var opts = msg.prompt.options;
                payload["PROMPT_FLAG"] = 1;
                var parts = [];
                var nums = [];
                if (opts.length === 2) {
                    parts.push("^ " + opts[0].label);
                    parts.push("v " + opts[1].label);
                    nums = [opts[0].num, 0, opts[1].num];
                } else {
                    parts.push("^ " + opts[0].label);
                    if (opts[1]) parts.push("o " + opts[1].label);
                    if (opts[2]) parts.push("v " + opts[2].label);
                    nums = [opts[0].num, opts[1] ? opts[1].num : 0, opts[2] ? opts[2].num : 0];
                }
                payload["PROMPT_TEXT"] = nums.join(",") + "|" + parts.join("  ");
            }

            if (msg.suggestion) {
                content += "\nS" + msg.suggestion;
                payload["TERMINAL_DATA"] = content;
            }
            pending = payload;
            trySend();

            // Also send CLEAN data if available
            if (msg.cleanData) {
                var cd = msg.cleanData;
                // Format: CLEAN:userCmd|summary|status|lastTool
                var cleanStr = "CLEAN:" + (cd.userCmd || "") + "|" + (cd.summary || "") + "|" + (cd.status || "Ready") + "|" + (cd.lastTool || "");
                // Send as separate message after a small delay
                setTimeout(function() {
                    Pebble.sendAppMessage({ "TERMINAL_DATA": cleanStr }, function(){}, function(){});
                }, 50);
            }
        }
    };

    function trySend() {
        if (sending || !pending) return;
        var payload = pending;
        pending = null;
        sending = true;
        Pebble.sendAppMessage(payload,
            function() { sending = false; trySend(); },
            function(e) { sending = false; setTimeout(trySend, 300); }
        );
    }

    Pebble.addEventListener('appmessage', function(e) {
        var key = e.payload["TERMINAL_DATA"];
        if (!key || !ws || ws.readyState !== 1) return;
        console.log("Watch: " + key);

        if (key === "list") {
            ws.send(JSON.stringify({ type: 'list' }));
        }
        else if (key === "create") {
            ws.send(JSON.stringify({ type: 'create' }));
        }
        else if (key === "leave") {
            ws.send(JSON.stringify({ type: 'leave' }));
        }
        else if (key.indexOf("join:") === 0) {
            ws.send(JSON.stringify({ type: 'join', name: key.substring(5) }));
        }
        else if (key === "accept") {
            ws.send(JSON.stringify({ type: 'accept' }));
        }
        else {
            ws.send(JSON.stringify({ type: 'key', content: key }));
        }
    });
});
