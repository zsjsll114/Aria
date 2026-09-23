with open(r'C:\Users\aboo\.gemini\antigravity\brain\b7c7016a-1fc8-493a-9c76-ef4c13d0901b\.system_generated\steps\5283\content.md', 'r', encoding='utf-8', errors='ignore') as f:
    text = f.read()

import re

# find all code blocks inside the file
codes = re.findall(r'<pre[^>]*>([\s\S]*?)</pre>', text)
print(f"Found {len(codes)} code blocks:")
for i, c in enumerate(codes):
    clean_c = re.sub(r'<[^>]+>', '', c).replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"').replace('&#39;', "'")
    print(f"\n--- Code Block #{i+1} ---")
    print(clean_c)
