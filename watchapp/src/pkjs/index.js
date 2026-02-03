Pebble.addEventListener('ready', function() {
    console.log("VibeCoder ready");
    var ws = null;
    var sending = false;
    var pending = null;
    var reconnectTimer = null;

    function connect() {
        ws = new WebSocket('ws://localhost:8080');

        ws.onopen = function() {
            console.log("Bridge OK");
            // Request session list on connect
            ws.send(JSON.stringify({ type: 'list_tmux' }));
        };

        ws.onclose = function() {
            console.log("Bridge lost, retry 3s");
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(connect, 3000);
        };

        ws.onerror = function(e) {
            console.log("WS error:", e.message);
        };

        ws.onmessage = function(e) {
            var msg = JSON.parse(e.data);
            console.log("Bridge msg type:", msg.type);

            // ===========================================
            // SESSION MANAGEMENT MESSAGES
            // ===========================================

            if (msg.type === 'session_list') {
                // Send session list to watch
                var content = "C> VibeCoder\n";
                if (msg.hasActive) {
                    content += "GActive session\n";
                } else {
                    content += "LNo active session\n";
                }
                content += "L---\n";

                // List tmux sessions
                if (msg.tmux && msg.tmux.length > 0) {
                    content += "CTmux sessions:\n";
                    msg.tmux.forEach(function(s, i) {
                        var status = s.attached ? " [*]" : "";
                        content += "W" + (i + 1) + ". " + s.name + status + "\n";
                    });
                } else {
                    content += "LNo tmux sessions\n";
                }

                // Show options
                content += "L---\n";
                content += "Y^ Create new\n";
                content += "Yo Refresh\n";
                content += "Yv Join session";

                var payload = {
                    "TERMINAL_DATA": content,
                    "PROMPT_FLAG": 1,
                    "PROMPT_TEXT": "1,2,3|^ New  o List  v Join"
                };
                pending = payload;
                trySend();
            }
            else if (msg.type === 'session_created') {
                var content = "G> Session created\n";
                content += "C" + msg.name + "\n";
                content += "WClaude is starting...\n";
                content += "LWaiting for hooks...";
                pending = { "TERMINAL_DATA": content };
                trySend();
            }
            else if (msg.type === 'session_joined') {
                var content = "G> Joined session\n";
                content += "C" + msg.name + "\n";
                content += "WConnected!";
                pending = { "TERMINAL_DATA": content };
                trySend();
            }
            else if (msg.type === 'error') {
                var content = "R> Error\n";
                content += "R" + msg.message;
                pending = { "TERMINAL_DATA": content };
                trySend();
            }
            // ===========================================
            // EXISTING OUTPUT HANDLING
            // ===========================================
            else if (msg.type === 'output') {
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
    }

    // Start connection
    connect();

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

            // ===========================================
            // SESSION MANAGEMENT COMMANDS
            // ===========================================
            if (key === "create_session") {
                ws.send(JSON.stringify({ type: 'create_session' }));
            }
            else if (key === "list_sessions") {
                ws.send(JSON.stringify({ type: 'list_tmux' }));
            }
            else if (key.startsWith("join:")) {
                var sessionName = key.substring(5);
                ws.send(JSON.stringify({ type: 'join_session', name: sessionName }));
            }
            // ===========================================
            // EXISTING COMMANDS
            // ===========================================
            else if (key === "accept") {
                ws.send(JSON.stringify({ type: 'accept' }));
            } else {
                ws.send(JSON.stringify({ type: 'key', content: key }));
            }
        }
    });
});
