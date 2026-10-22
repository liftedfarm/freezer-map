"""Nursery leachate history: the Field Leachate sheet of WebbNursery_2026.xlsx -> rows for nursery_leachate (in 041_leachate.sql).
Hoops 1-18 are Webb, 1z-6z are Zion hoops 1-6, GH the greenhouse."""
import datetime, sys, warnings
import openpyxl
warnings.filterwarnings('ignore')
wb = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=True)
def q(v):
    if v is None or (isinstance(v, str) and (not v.strip() or v.startswith('#'))): return 'null'
    if isinstance(v, (int, float)): return str(round(float(v), 3))
    return "'" + str(v).strip().replace("'", "''") + "'"
def num(v):
    return v if isinstance(v, (int, float)) else None
out = []
for r in wb['Field Leachate'].iter_rows(min_row=4, values_only=True):
    if not isinstance(r[1], datetime.datetime): continue
    hoop = r[0]
    if hoop is None: continue
    h = str(hoop).strip()
    place, name = ('Zion', f'Zion Hoop {h[:-1]}') if h.endswith('z') else ('Webb', 'Greenhouse' if h == 'GH' else f'Hoop {h}')
    pct = num(r[14])
    vals = [q(place), q(name), f"'{r[1].date().isoformat()}'", q(num(r[2])), q(num(r[3])), q(num(r[4])), q(num(r[5])), q(num(r[6])), q(num(r[7])), q(num(r[8])),
            q(num(r[9])), q(num(r[10])), q(num(r[11])), q(num(r[12])), q(num(r[13])), q(round(pct * 100, 1) if pct is not None else None), q(r[16])]
    out.append('(' + ', '.join(vals) + ')')
sys.stdout.write(',\n'.join(out))
sys.stderr.write(f'{len(out)} leachate rows\n')
