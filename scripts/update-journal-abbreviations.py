"""Build the offline ISSN and journal-title indexes used by metadata previews."""

import csv
import io
import json
import re
import unicodedata
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "addon/modules/metadata/journal-abbreviations.json"
QUERY = "SELECT ?item ?issn ?abbr WHERE { ?item wdt:P1160 ?abbr; wdt:P236 ?issn. }"
WIKIDATA = "https://query.wikidata.org/sparql?" + urllib.parse.urlencode({"format": "json", "query": QUERY})
JABREF = "https://raw.githubusercontent.com/JabRef/abbrv.jabref.org/main/journals/"
# Abbreviated key title confirmed at https://publishers.issn.org/resource/ISSN-L/2475-9066.
ISSN_PORTAL = {"2475-9066": "J. Open Source Softw."}


def download(url):
    request = urllib.request.Request(url, headers={
        "User-Agent": "Zotero-Centers/1.2 (https://github.com/mapengsen/zotero-centers) bibliographic data integration",
    })
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.read().decode("utf-8-sig")


def text(value):
    return " ".join(unicodedata.normalize("NFKC", value).split())


def unique_abbreviations(entries):
    values = defaultdict(set)
    for key, abbreviation in entries:
        values[key].add(abbreviation)
    return {
        key: min(variants) for key, variants in values.items()
        if len({value.lower() for value in variants}) == 1
    }


def issn_entries(data):
    for row in json.loads(data)["results"]["bindings"]:
        issn = text(row["issn"]["value"]).upper()
        abbreviation = text(row["abbr"]["value"])
        if re.fullmatch(r"[0-9]{4}-[0-9]{3}[0-9X]", issn) and abbreviation:
            yield issn, abbreviation


def title_entries(data):
    for row in csv.reader(io.StringIO(data)):
        if len(row) < 2:
            continue
        title = text(row[0]).lower()
        abbreviation = text(row[1])
        if title and abbreviation and ("." in abbreviation or title == abbreviation.lower()):
            yield title, abbreviation


def main():
    urls = [WIKIDATA, *(JABREF + f"journal_abbreviations_{name}.csv" for name in ("lifescience", "acs"))]
    with ThreadPoolExecutor() as pool:
        wikidata, *jabref = pool.map(download, urls)
    issns = unique_abbreviations(issn_entries(wikidata))
    issns.update(ISSN_PORTAL)
    titles = unique_abbreviations(entry for data in jabref for entry in title_entries(data))
    if not issns or not titles:
        raise ValueError("An abbreviation index is empty")
    data = {"byISSN": issns, "byTitle": titles}
    OUTPUT.write_bytes((json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8"))
    print(f"Wrote {len(issns):,} ISSN keys and {len(titles):,} title keys")


if __name__ == "__main__":
    main()
