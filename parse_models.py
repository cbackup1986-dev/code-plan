import json
import sys

def try_read(filename, encoding):
    try:
        with open(filename, 'r', encoding=encoding) as f:
            return json.load(f)
    except:
        return None

data = try_read('models.json', 'utf-16')
if data is None:
    data = try_read('models.json', 'utf-16le')
if data is None:
    data = try_read('models.json', 'utf-8-sig')
if data is None:
    data = try_read('models.json', 'utf-8')

if data:
    models = [m['id'] for m in data.get('data', [])]
    for m in sorted(models):
        print(m)
else:
    print("Could not read models.json")
