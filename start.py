import http.server
import socketserver
import webbrowser

PORT = 8000

print("Starting local server...")
print(f"Open: http://localhost:{PORT}/taskboard.html")

webbrowser.open(f"http://localhost:{PORT}/taskboard.html")

Handler = http.server.SimpleHTTPRequestHandler

with socketserver.TCPServer(("", PORT), Handler) as httpd:
    httpd.serve_forever()
