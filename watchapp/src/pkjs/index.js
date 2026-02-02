Pebble.addEventListener('ready', function() {
    console.log("VibeCoder ready");
    var ws = new WebSocket('ws://localhost:8080');
    var sending = false;
    var pending = null;

    ws.onopen = function() { console.log("Bridge OK"); };
    ws.onclose = function() {
        console.log("Bridge lost, retry 3s");
        setTimeout(function() { ws = new WebSocket('ws://localhost:8080'); }, 3000);
    };

    ws.onmessage = function(e) {
        var msg = JSON.parse(e.data);
        if (msg.type === 'output') {
            var content = msg.content;
            if (content.length > 1900) content = content.substring(content.length - 1900);
            // Cut to next full line to keep color codes intact
            var nl = content.indexOf('\n');
            if (nl >= 0 && nl < 50) content = content.substring(nl + 1);
            var payload = { "TERMINAL_DATA": content };
            if (msg.prompt && msg.prompt.options) {
                var opts = msg.prompt.options;
                payload["PROMPT_FLAG"] = 1;
                // Build prompt bar text: map to UP/SELECT/DOWN buttons
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
                // Format: "up,sel,down|display text"
                payload["PROMPT_TEXT"] = nums.join(",") + "|" + parts.join("  ");
                console.log("PROMPT: " + payload["PROMPT_TEXT"]);
            }
            // Append suggestion as last line with 'S' color code
            if (msg.suggestion) {
                content += "\nS" + msg.suggestion;
                payload["TERMINAL_DATA"] = content;
            }
            pending = payload;
            trySend();
        }
    };

    function trySend() {
        if (sending || !pending) return;
        var payload = pending;
        pending = null;
        sending = true;
        console.log("Sending " + payload["TERMINAL_DATA"].length + " bytes");
        Pebble.sendAppMessage(payload,
            function() { sending = false; console.log("Send OK"); trySend(); },
            function(e) { sending = false; console.log("Send FAIL: " + JSON.stringify(e)); setTimeout(trySend, 300); }
        );
    }

    // Receive button presses from watch
    Pebble.addEventListener('appmessage', function(e) {
        var key = e.payload["TERMINAL_DATA"];
        if (key && ws && ws.readyState === 1) {
            console.log("Button: " + key);
            if (key === "accept") {
                ws.send(JSON.stringify({ type: 'accept' }));
            } else {
                ws.send(JSON.stringify({ type: 'key', content: key }));
            }
        }
    });
});
