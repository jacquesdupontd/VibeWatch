Pebble.addEventListener('ready', function () {
    console.log("VibeCoder ready");
    var ws = null;
    var sending = false;

    function connect() {
        ws = new WebSocket('ws://localhost:8080');

        ws.onopen = function () {
            console.log("Bridge OK");
            // Request session list on connect
            ws.send(JSON.stringify({ type: 'list' }));
        };

        ws.onclose = function () {
            console.log("Bridge lost, retry 3s");
            setTimeout(connect, 3000);
        };

        ws.onmessage = function (e) {
        var msg = JSON.parse(e.data);
        console.log("Bridge msg: " + msg.type);

        if (msg.type === 'menu') {
            // Send menu to watch: MENU:session1,session2,...
            var sessions = msg.sessions || [];
            queue.push({ "TERMINAL_DATA": "MENU:" + sessions.join(",") });
            trySend();
        }
        else if (msg.type === 'session_joined' || msg.type === 'session_created') {
            // Send session name to watch
            queue.push({ "TERMINAL_DATA": "SESSION:" + msg.name });
            trySend();
        }
        else if (msg.type === 'output') {
            var content = msg.content;

            // Emoji/non-ASCII stripping (Hyper Robust)
            // Pebble only supports a limited charset. Stripping all non-ASCII 
            // is the safest way to avoid weird squares.
            function cleanEmojis(str) {
                if (!str) return "";
                // Replace accents then strip non-ASCII
                var s = str
                    .replace(/à|á|â|ä|ã|å/g, "a")
                    .replace(/À|Á|Â|Ä|Ã|Å/g, "A")
                    .replace(/ç/g, "c")
                    .replace(/Ç/g, "C")
                    .replace(/è|é|ê|ë/g, "e")
                    .replace(/È|É|Ê|Ë/g, "E")
                    .replace(/ì|í|î|ï/g, "i")
                    .replace(/Ì|Í|Î|Ï/g, "I")
                    .replace(/ñ/g, "n")
                    .replace(/Ñ/g, "N")
                    .replace(/ò|ó|ô|ö|õ/g, "o")
                    .replace(/Ò|Ó|Ô|Ö|Õ/g, "O")
                    .replace(/ù|ú|û|ü/g, "u")
                    .replace(/Ù|Ú|Û|Ü/g, "U")
                    .replace(/ý|ÿ/g, "y")
                    .replace(/Ý/g, "Y");
                return s.replace(/[^\x00-\x7F]/g, " ").replace(/\s+/g, " ").trim();
            }

            content = cleanEmojis(content);

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
                var sug = cleanEmojis(msg.suggestion);
                content += "\nS" + sug;
                payload["TERMINAL_DATA"] = content;
            }
            queue.push(payload);

            // Also send CLEAN data if available
            if (msg.cleanData) {
                var cd = msg.cleanData;
                // Sanitize: replace pipe chars and strip emojis
                function sanitizePreserveNewlines(s) {
                    if (!s) return "";
                    var out = s
                        .replace(/à|á|â|ä|ã|å/g, "a")
                        .replace(/À|Á|Â|Ä|Ã|Å/g, "A")
                        .replace(/ç/g, "c")
                        .replace(/Ç/g, "C")
                        .replace(/è|é|ê|ë/g, "e")
                        .replace(/È|É|Ê|Ë/g, "E")
                        .replace(/ì|í|î|ï/g, "i")
                        .replace(/Ì|Í|Î|Ï/g, "I")
                        .replace(/ñ/g, "n")
                        .replace(/Ñ/g, "N")
                        .replace(/ò|ó|ô|ö|õ/g, "o")
                        .replace(/Ò|Ó|Ô|Ö|Õ/g, "O")
                        .replace(/ù|ú|û|ü/g, "u")
                        .replace(/Ù|Ú|Û|Ü/g, "U")
                        .replace(/ý|ÿ/g, "y")
                        .replace(/Ý/g, "Y");
                    // Strip non-ASCII but preserve newlines
                    out = out.replace(/[^\x00-\x7F\n]/g, "");
                    // Replace pipes to keep CLEAN split safe
                    return out.replace(/\|/g, " ");
                }
                // Format: CLEAN:userCmd|summary|status|lastTool|suggestion|activeTask
                var cleanStr = "CLEAN:" + sanitizePreserveNewlines(cd.userCmd) + "|" + sanitizePreserveNewlines(cd.summary) + "|" + sanitizePreserveNewlines(cd.status) + "|" + sanitizePreserveNewlines(cd.lastTool) + "|" + sanitizePreserveNewlines(cd.suggestion) + "|" + sanitizePreserveNewlines(cd.activeTask);
                queue.push({ "TERMINAL_DATA": cleanStr });
            }
            trySend();
        }
        };
    }

    connect();

    var queue = [];
    function trySend() {
        if (sending || queue.length === 0) return;
        var payload = queue.shift();
        sending = true;

        // Timeout to avoid permanent lock if callback lost
        var safetyTimeout = setTimeout(function () {
            if (sending) {
                console.log("Msg timeout - resetting queue");
                sending = false;
                trySend();
            }
        }, 3000);

        Pebble.sendAppMessage(payload,
            function () {
                clearTimeout(safetyTimeout);
                sending = false;
                setTimeout(trySend, 20); // Small gap 
            },
            function (e) {
                clearTimeout(safetyTimeout);
                console.log("Send failed, retrying...");
                queue.unshift(payload); // Put back
                sending = false;
                setTimeout(trySend, 500);
            }
        );
    }

    Pebble.addEventListener('appmessage', function (e) {
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
