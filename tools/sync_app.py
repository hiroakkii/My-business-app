"""まとめ版の apps/<名前> の内容を、元のリポジトリのチェックアウトへ反映する。

使い方: python3 sync_app.py <まとめ版のアプリのフォルダ> <元リポジトリのフォルダ>
- まとめ版専用の「一括取込」用の読み込み行（portal-import.js）は除く
- node_modules・.git は対象外
- 元リポジトリにあって、まとめ版に無いファイルは消さない
"""
import os
import re
import shutil
import sys

src, dst = sys.argv[1], sys.argv[2]
SKIP = {'.git', 'node_modules'}
PORTAL = re.compile(r'<!-- まとめ版の「患者マスタ一括取込」用[^\n]*-->\n<script src="\.\./common/portal-import\.js"[^\n]*</script>\n')

changed = []
for root, dirs, files in os.walk(src):
    dirs[:] = [d for d in dirs if d not in SKIP]
    for name in files:
        a = os.path.join(root, name)
        rel = os.path.relpath(a, src)
        b = os.path.join(dst, rel)
        os.makedirs(os.path.dirname(b), exist_ok=True)
        if name.endswith('.html'):
            text = open(a, encoding='utf-8').read()
            text = PORTAL.sub('', text)
            data = text.encode('utf-8')
        else:
            data = open(a, 'rb').read()
        if not os.path.exists(b) or open(b, 'rb').read() != data:
            open(b, 'wb').write(data)
            changed.append(rel)
print('更新したファイル:')
for c in sorted(changed):
    print(' ', c)
