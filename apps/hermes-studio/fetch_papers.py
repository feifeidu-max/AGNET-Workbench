#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Fetch candidate papers from OpenAlex for the data-engineering paper recommendation cron job."""
import urllib.request, urllib.parse, json, time, sys

def openalex(query, years="2024-2026", per_page=25):
    params = {
        "search": query,
        "filter": "publication_year:{},type:article|type:review".format(years),
        "per-page": str(per_page),
        "sort": "cited_by_count:desc",
        "mailto": "hermes-research@example.com",
    }
    url = "https://api.openalex.org/works?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "hermes-cron/1.0 (mailto:hermes-research@example.com)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())

QUERIES = ["lakehouse", "data lake", "data governance", "data quality",
           "data ingestion", "stream processing", "data platform", "data security"]

VENUE_KEYWORDS = ["vldb", "sigmod", "icde", "data engineering", "kdd", "tpds",
                  "big data", "edbt", "cidr", "tkde", "debs", "distributed",
                  "management of data", "data mining", "knowledge and data"]

EXCLUDE_TERMS = ["point cloud", "pointcloud", "voxel", "near-memory", "near memory",
                 "processing-in-memory", "processing in memory", "accelerator", "fpga",
                 "hardware acceleration", "neural network accelerator", "sram",
                 "in-memory computing", "neural processing unit", "npu", "cam-based",
                 "content addressable"]

seen = {}
for q in QUERIES:
    try:
        data = openalex(q)
    except Exception as e:
        print("[{}] ERROR: {}".format(q, e), file=sys.stderr)
        continue
    results = data.get("results", [])
    print("[{}] fetched {} results".format(q, len(results)), file=sys.stderr)
    for w in results:
        wid = w.get("id")
        if wid in seen:
            continue
        title = (w.get("display_name") or "").strip()
        tl = title.lower()
        if any(x in tl for x in EXCLUDE_TERMS):
            continue
        loc = w.get("primary_location") or {}
        src = loc.get("source") or {}
        venue = (src.get("display_name") or "")
        vl = venue.lower()
        if not any(k in vl for k in VENUE_KEYWORDS):
            continue
        year = w.get("publication_year") or 0
        if year < 2023:
            continue
        authors = [a["author"]["display_name"] for a in (w.get("authorships") or [])][:8]
        doi = w.get("doi")
        url = w.get("open_access", {}).get("oa_url") or (("https://doi.org/" + doi) if doi else None)
        seen[wid] = {
            "title": title, "year": year, "venue": venue, "doi": doi,
            "url": url, "authors": authors, "cited": w.get("cited_by_count") or 0,
        }
    time.sleep(0.25)

items = sorted(seen.values(), key=lambda x: (-(x["year"] or 0), -(x["cited"] or 0)))
print("TOTAL candidates: {}".format(len(items)))
for it in items:
    print("{} | {} | {} | cited={} | doi={}".format(
        it["year"], it["title"][:95], it["venue"][:65], it["cited"], it["doi"]))