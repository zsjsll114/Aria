import json, re

with open(r'C:\Users\aboo\.gemini\antigravity\brain\b7c7016a-1fc8-493a-9c76-ef4c13d0901b\.system_generated\steps\5283\content.md', 'r', encoding='utf-8') as f:
    text = f.read()

m = re.search(r'<script type="application/ld\+json">([\s\S]*?)</script>', text)
if m:
    data = json.loads(m.group(1))
    article_html = data.get('mainEntity', {}).get('text', '')
    clean_text = re.sub(r'<pre[^>]*>([\s\S]*?)</pre>', r'\n```\n\1\n```\n', article_html)
    clean_text = re.sub(r'<code[^>]*>([\s\S]*?)</code>', r'\1', clean_text)
    clean_text = re.sub(r'<[^>]+>', '', clean_text)
    print(clean_text)
