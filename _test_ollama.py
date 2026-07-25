import httpx

try:
    r = httpx.get("http://localhost:11434/api/tags", timeout=10)
    data = r.json()
    models = data.get("models", [])
    print(f"Ollama OK — {len(models)} model(s):")
    for m in models:
        size_mb = m.get("size", 0) // (1024 * 1024)
        print(f"  {m['name']} ({size_mb}MB)")
except Exception as e:
    print(f"Ollama error: {e}")
