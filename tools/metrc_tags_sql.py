#!/usr/bin/env python3
"""Turn METRC "Tags > Available" exports into a tag-range migration.

  python3 tools/metrc_tags_sql.py OUT.sql "title" LICENSE:SITE:PACKAGE_USE:FILE.xlsx [...]

Each run of consecutive available tags becomes one tag_ranges row, so tags already used in METRC (the gaps)
are never suggested. Plant vs package tags come from the 7th character (1A40602... plant, 1A40603... package).
PACKAGE_USE is what the app uses that license's package tags for: harvest, mixed or package.
Re-running the SQL replaces the ranges it loaded before for those licenses (notes start with 'METRC export').
"""
import sys
import openpyxl


def runs(ns):
    ns = sorted(set(ns))
    out, s, e = [], ns[0], ns[0]
    for n in ns[1:]:
        if n == e + 1:
            e = n
        else:
            out.append((s, e)); s = e = n
    out.append((s, e))
    return out


def main():
    out, title, *specs = sys.argv[1:]
    rows, lics, summary = [], [], []
    for spec in specs:
        lic, site, pkg_use, path = spec.split(':', 3)
        lics.append(lic)
        ws = openpyxl.load_workbook(path, read_only=True).worksheets[0]
        groups = {}
        for (t, *_) in ws.iter_rows(min_row=2, values_only=True):
            if not t:
                continue
            t = str(t).strip().upper()
            if len(t) != 24:
                raise SystemExit(f'odd tag {t!r} in {path}')
            groups.setdefault(t[:15], []).append(int(t[15:]))
        for pre, ns in groups.items():
            kind = 'plant' if pre[6] == '2' else 'package'
            use = 'plant' if kind == 'plant' else pkg_use
            rs = runs(ns)
            summary.append(f'--   {lic} {use}: {len(set(ns)):,} tags in {len(rs)} ranges')
            rows += [f"  ('{site}', '{use}', '{pre}', {a}, {b}, 9, 'METRC export {title} ({kind} tags)', '{lic}')" for a, b in rs]
    lic_list = ', '.join(f"'{x}'" for x in lics)
    with open(out, 'w') as f:
        f.write(f"-- METRC tags available ({title}), loaded as tag ranges per license. Safe to re-run.\n")
        f.write("-- Each run of consecutive available tags is one range; plant vs package from the 7th character of the tag.\n")
        f.write('\n'.join(summary) + '\n')
        f.write("set client_min_messages = warning;\n\n")
        f.write(f"delete from tag_ranges where license in ({lic_list}) and notes like 'METRC export%';\n")
        f.write("insert into tag_ranges (site, purpose, prefix, first_n, last_n, digits, notes, license) values\n")
        f.write(',\n'.join(rows) + ';\n\n')
        f.write("select license, purpose, count(*) as ranges, sum(last_n - first_n + 1) as tags from tag_ranges\n")
        f.write(f" where license in ({lic_list}) group by 1, 2 order by 1, 2;\n")
    print('\n'.join(summary))


if __name__ == '__main__':
    main()
