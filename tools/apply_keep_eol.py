"""元のファイルの行末（CRLF/LF）を保ったまま、変更した行だけを反映する。

使い方: python3 apply_keep_eol.py <元のファイル（上書きされる）> <新しい内容のファイル>
- 変更の無い行は、元の行をそのまま残す
- 追加・変更した行の行末は、直前の元の行と同じにする
"""
import difflib
import re
import sys

orig_path, new_path = sys.argv[1], sys.argv[2]
PORTAL = re.compile(r'<!-- まとめ版の「患者マスタ一括取込」用[^\n]*-->\n<script src="\.\./common/portal-import\.js"[^\n]*</script>\n')

orig = open(orig_path, 'rb').read().decode('utf-8').splitlines(keepends=True)
new_text = PORTAL.sub('', open(new_path, 'rb').read().decode('utf-8'))
new = new_text.splitlines(keepends=True)

strip = lambda l: l.rstrip('\r\n')
sm = difflib.SequenceMatcher(None, [strip(l) for l in orig], [strip(l) for l in new], autojunk=False)
out = []
for tag, i1, i2, j1, j2 in sm.get_opcodes():
    if tag == 'equal':
        out.extend(orig[i1:i2])
    elif tag in ('replace', 'insert'):
        ref = orig[i1 - 1] if i1 > 0 else (orig[0] if orig else '\n')
        eol = '\r\n' if ref.endswith('\r\n') else '\n'
        for l in new[j1:j2]:
            out.append(strip(l) + (eol if l.endswith('\n') else ''))
    # delete: 何も出さない
open(orig_path, 'wb').write(''.join(out).encode('utf-8'))
print('反映しました。元の行数', len(orig), '→', len(out))
