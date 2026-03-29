import com.sun.net.httpserver.*;
import java.io.*;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.util.stream.Collectors;

/**
 * Proxy local pour l'API Claude — aucune configuration requise.
 * La clé API est transmise par le navigateur dans le body JSON.
 * Usage: java proxy.java
 * Écoute sur http://localhost:3001/api/analyze
 */
public class proxy {
    public static void main(String[] args) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress(3001), 0);

        server.createContext("/api/analyze", exchange -> {
            exchange.getResponseHeaders().add("Access-Control-Allow-Origin", "*");
            exchange.getResponseHeaders().add("Access-Control-Allow-Methods", "POST, OPTIONS");
            exchange.getResponseHeaders().add("Access-Control-Allow-Headers", "Content-Type");

            if (exchange.getRequestMethod().equalsIgnoreCase("OPTIONS")) {
                exchange.sendResponseHeaders(200, -1);
                return;
            }
            if (!exchange.getRequestMethod().equalsIgnoreCase("POST")) {
                exchange.sendResponseHeaders(405, -1);
                return;
            }

            try {
                String body = new BufferedReader(
                    new InputStreamReader(exchange.getRequestBody(), StandardCharsets.UTF_8))
                    .lines().collect(Collectors.joining("\n"));

                String apiKey = extractField(body, "apiKey");
                String prompt  = extractField(body, "prompt");

                if (apiKey.isEmpty()) {
                    sendJson(exchange, 400, "{\"error\":\"Clé API manquante\"}");
                    return;
                }

                // Build Claude request body
                String claudeBody = "{\"model\":\"claude-haiku-4-5-20251001\",\"max_tokens\":1500," +
                    "\"messages\":[{\"role\":\"user\",\"content\":" + jsonString(prompt) + "}]}";

                HttpClient client = HttpClient.newHttpClient();
                HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create("https://api.anthropic.com/v1/messages"))
                    .header("Content-Type", "application/json")
                    .header("x-api-key", apiKey)
                    .header("anthropic-version", "2023-06-01")
                    .POST(HttpRequest.BodyPublishers.ofString(claudeBody))
                    .build();

                HttpResponse<String> resp = client.send(req, HttpResponse.BodyHandlers.ofString());

                if (resp.statusCode() != 200) {
                    sendJson(exchange, resp.statusCode(), "{\"error\":" + jsonString(resp.body()) + "}");
                    return;
                }

                String text = extractText(resp.body());
                sendJson(exchange, 200, "{\"text\":" + jsonString(text) + "}");

            } catch (Exception e) {
                sendJson(exchange, 500, "{\"error\":" + jsonString(e.getMessage()) + "}");
            }
        });

        server.start();
        System.out.println("✓ Proxy Claude démarré → http://localhost:3001");
        System.out.println("  Laisse cette fenêtre ouverte et utilise le site normalement.");
    }

    static void sendJson(HttpExchange ex, int code, String json) throws IOException {
        byte[] out = json.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json");
        ex.sendResponseHeaders(code, out.length);
        ex.getResponseBody().write(out);
        ex.getResponseBody().close();
    }

    // Extract a string field from a flat JSON object (no nested support needed)
    static String extractField(String json, String field) {
        String key = "\"" + field + "\"";
        int idx = json.indexOf(key);
        if (idx < 0) return "";
        idx += key.length();
        while (idx < json.length() && (json.charAt(idx) == ':' || json.charAt(idx) == ' ')) idx++;
        if (idx >= json.length() || json.charAt(idx) != '"') return "";
        idx++;
        StringBuilder sb = new StringBuilder();
        boolean esc = false;
        for (int i = idx; i < json.length(); i++) {
            char c = json.charAt(i);
            if (esc) {
                if (c == 'n') sb.append('\n');
                else if (c == 't') sb.append('\t');
                else if (c == 'r') sb.append('\r');
                else sb.append(c);
                esc = false;
            } else if (c == '\\') { esc = true; }
            else if (c == '"') break;
            else sb.append(c);
        }
        return sb.toString();
    }

    // Extract "text" from Claude API response
    static String extractText(String json) {
        return extractField(json, "text");
    }

    // Escape a Java string to a JSON string literal
    static String jsonString(String s) {
        if (s == null) s = "";
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"")
            .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t") + "\"";
    }
}
