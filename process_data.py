"""
process_data.py — CWAC Quarterly Scan CSV → leaderboard.json
Usage (from workspace root): python process_data.py

Scoring methodology (0–100, higher is better):
  axe_core        : % of pages with zero WCAG violations        (weight 40%)
  focus_indicator : % of pages with zero focus-visibility issues (weight 30%)
  reflow          : % of pages with zero horizontal overflow     (weight 20%)
  language        : readability; FK grade ≤8 = 100, –5pts/grade above 8 (weight 10%)
  overall         : weighted composite of the four above

If focus_indicator CSV is absent from a scan, that dimension is scored null and
overall is computed from the remaining three dimensions (weights renormalised to 100%).

Scan discovery: any directory matching YYYY-MM-DD_quarterly_cwac_scan/ is
auto-detected. Nested duplicate directories (e.g. 2025-09-29.../2025-09-29...) are
handled transparently. Simply drop a new scan folder in the workspace root and
re-run; no constants need updating.

History: each organisation and site record includes a `history` object containing
scores from every scan except the latest, keyed by date string. Deltas are
computed client-side in the UI based on the user's chosen comparison date.
"""

import csv
import json
import os
import re
import collections
from datetime import datetime

OUT_DIR = "data"

# ---------------------------------------------------------------------------
# Scoring constants
# ---------------------------------------------------------------------------
WEIGHT_AXE = 0.40  # Axe Core — WCAG violations           (40 %)
WEIGHT_FOCUS = 0.30  # Focus Indicator — visibility          (30 %)
WEIGHT_REFLOW = 0.20  # Reflow — 320 px horizontal overflow   (20 %)
WEIGHT_LANG = 0.10  # Language — Flesch-Kincaid readability (10 %)

LANG_FK_TARGET = 8  # NZ Gov target: FK grade ≤ 8 → 100 pts
LANG_FK_PENALTY_STEP = 5  # Points deducted per grade above target

# ---------------------------------------------------------------------------
# Scan discovery
# ---------------------------------------------------------------------------


def discover_scans():
    """
    Auto-detect all YYYY-MM-DD_quarterly_cwac_scan directories.
    Returns list of (date_str, resolved_scan_dir) sorted newest-first.
    Handles the nested duplicate-name pattern (e.g. 2025-09-29.../2025-09-29...).
    """
    results = []
    for entry in os.scandir("."):
        if not entry.is_dir():
            continue
        m = re.match(r"^(\d{4}-\d{2}-\d{2})_quarterly_cwac_scan$", entry.name)
        if not m:
            continue
        date = m.group(1)
        scan_dir = entry.path
        # Handle nested duplicate (inner dir has same name pattern)
        inner = os.path.join(scan_dir, f"{date}_quarterly_cwac_scan")
        if os.path.isdir(inner):
            scan_dir = inner
        results.append((date, scan_dir))
    return sorted(results, key=lambda x: x[0], reverse=True)  # newest first


# ---------------------------------------------------------------------------
# Low-level CSV helpers  (scan-dir aware)
# ---------------------------------------------------------------------------

def read_csv(scan_dir, filename):
    path = os.path.join(scan_dir, filename)
    with open(path, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def _csv_iter(scan_dir, filename):
    path = os.path.join(scan_dir, filename)
    with open(path, encoding="utf-8-sig") as f:
        yield from csv.DictReader(f)


# ---------------------------------------------------------------------------
# Per-datasource processors  (all take scan_date + scan_dir)
# ---------------------------------------------------------------------------

def process_pages_scanned(scan_date, scan_dir):
    rows = read_csv(scan_dir, f"{scan_date}_pages_scanned.csv")
    pages = {}          # (org, base_url) → int
    org_sector = {}     # org → sector
    for r in rows:
        key = (r["organisation"], r["base_url"])
        pages[key] = int(r["number_of_pages"])
        org_sector[r["organisation"]] = r["sector"]
    return pages, org_sector


def process_axe_core(scan_date, scan_dir):
    data = collections.defaultdict(lambda: {
        "page_ids_all":      set(),
        "page_ids_violated": set(),
        "violations_by_impact": collections.Counter(),
    })
    for r in _csv_iter(scan_dir, f"{scan_date}_axe_core_audit_template_aware.csv"):
        key = (r["organisation"], r["base_url"])
        data[key]["page_ids_all"].add(r["page_id"])
        if r["description"] != "No issues found":
            data[key]["page_ids_violated"].add(r["page_id"])
            impact = r.get("impact") or "unknown"
            data[key]["violations_by_impact"][impact] += 1
    return {
        key: {
            "pages_with_violations": len(v["page_ids_violated"]),
            "violations_by_impact":  dict(v["violations_by_impact"]),
        }
        for key, v in data.items()
    }


def process_focus_indicator(scan_date, scan_dir):
    """Returns dict or None if the CSV is absent for this scan."""
    path = os.path.join(scan_dir, f"{scan_date}_focus_indicator_audit.csv")
    if not os.path.exists(path):
        return None          # ← signal that focus data is unavailable

    data = collections.defaultdict(
        lambda: {"page_ids_with_issues": set(), "total_issues": 0})
    with open(path, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            key = (r["organisation"], r["base_url"])
            num = int(r.get("num_issues") or 0)
            if num > 0:
                data[key]["page_ids_with_issues"].add(r["page_id"])
                data[key]["total_issues"] += num
    return {
        key: {
            "pages_with_issues": len(v["page_ids_with_issues"]),
            "total_issues":      v["total_issues"],
        }
        for key, v in data.items()
    }


def process_reflow(scan_date, scan_dir):
    data = collections.defaultdict(
        lambda: {"page_ids_overflow": set(), "total_overflow_px": 0})
    for r in _csv_iter(scan_dir, f"{scan_date}_reflow_audit.csv"):
        key = (r["organisation"], r["base_url"])
        if r.get("overflows", "").strip().upper() == "TRUE":
            data[key]["page_ids_overflow"].add(r["page_id"])
            data[key]["total_overflow_px"] += int(
                r.get("overflow_amount_px") or 0)
    return {
        key: {
            "pages_with_overflow": len(v["page_ids_overflow"]),
            "total_overflow_px":   v["total_overflow_px"],
        }
        for key, v in data.items()
    }


def process_language(scan_date, scan_dir):
    data = collections.defaultdict(lambda: {
        "seen_page_ids": set(), "fk_sum": 0.0, "smog_sum": 0.0, "count": 0,
    })
    for r in _csv_iter(scan_dir, f"{scan_date}_language_audit.csv"):
        key = (r["organisation"], r["base_url"])
        pid = r["page_id"]
        if pid in data[key]["seen_page_ids"]:
            continue
        data[key]["seen_page_ids"].add(pid)
        data[key]["fk_sum"] += float(r.get("flesch_kincaid_gl") or 0)
        data[key]["smog_sum"] += float(r.get("smog_gl") or 0)
        data[key]["count"] += 1
    return {
        key: {
            "avg_flesch_kincaid": round(v["fk_sum"] / v["count"], 2),
            "avg_smog":           round(v["smog_sum"] / v["count"], 2),
            "page_count":         v["count"],
        }
        for key, v in data.items()
        if v["count"] > 0
    }


# ---------------------------------------------------------------------------
# Scoring functions  (all return 0–100)
# ---------------------------------------------------------------------------

def score_axe(pages_with_violations, pages_scanned):
    if pages_scanned == 0:
        return 0.0
    return round(max(0, pages_scanned - pages_with_violations) / pages_scanned * 100, 1)


def score_focus(pages_with_issues, pages_scanned):
    if pages_scanned == 0:
        return 0.0
    return round(max(0, pages_scanned - pages_with_issues) / pages_scanned * 100, 1)


def score_reflow(pages_with_overflow, pages_scanned):
    if pages_scanned == 0:
        return 0.0
    return round(max(0, pages_scanned - pages_with_overflow) / pages_scanned * 100, 1)


def score_language(avg_fk):
    if avg_fk <= 0:
        return 100.0
    if avg_fk <= LANG_FK_TARGET:
        return 100.0
    return round(max(0.0, 100.0 - (avg_fk - LANG_FK_TARGET) * LANG_FK_PENALTY_STEP), 1)


def overall_score(axe_s, focus_s, reflow_s, lang_s):
    """focus_s may be None if focus data is unavailable — weights are renormalised."""
    if focus_s is None:
        # Renormalise remaining weights proportionally when focus data is absent
        total = WEIGHT_AXE + WEIGHT_REFLOW + WEIGHT_LANG
        return round(
            axe_s * (WEIGHT_AXE / total)
            + reflow_s * (WEIGHT_REFLOW / total)
            + lang_s * (WEIGHT_LANG / total),
            1,
        )
    return round(
        axe_s * WEIGHT_AXE
        + focus_s * WEIGHT_FOCUS
        + reflow_s * WEIGHT_REFLOW
        + lang_s * WEIGHT_LANG,
        1,
    )


# ---------------------------------------------------------------------------
# Process one full scan → returns (sites_by_key, orgs_by_name)
# ---------------------------------------------------------------------------

def process_scan(scan_date, scan_dir):
    """
    Returns (sites_dict, orgs_dict) where:
      sites_dict : {base_url → {scores, details, pages_scanned, sector, organisation}}
      orgs_dict  : {org_name → {scores, details, pages_scanned, sector, sites[]}}
    """
    print(f"  [{scan_date}] pages …")
    pages_scanned, org_sector = process_pages_scanned(scan_date, scan_dir)

    print(f"  [{scan_date}] axe-core …")
    axe_data = process_axe_core(scan_date, scan_dir)

    print(f"  [{scan_date}] focus indicator …")
    focus_data = process_focus_indicator(scan_date, scan_dir)
    has_focus = focus_data is not None

    print(f"  [{scan_date}] reflow …")
    reflow_data = process_reflow(scan_date, scan_dir)

    print(f"  [{scan_date}] language …")
    lang_data = process_language(scan_date, scan_dir)

    if not has_focus:
        print(f"  [{scan_date}] NOTE: focus_indicator CSV not found — "
              "focus scores will be null, overall renormalised.")

    # Build per-site records and roll up org buckets
    org_buckets = collections.defaultdict(lambda: {
        "sites":         [],
        "pages":         0,
        "axe_violated":  0,
        "axe_impacts":   collections.Counter(),
        "focus_pages":   0,
        "focus_total":   0,
        "reflow_pages":  0,
        "reflow_px":     0,
        "lang_fk_sum":   0.0,
        "lang_smog_sum": 0.0,
        "lang_count":    0,
    })

    sites_dict = {}   # base_url → record

    for (org, base_url), pg in sorted(pages_scanned.items()):
        key = (org, base_url)

        axe = axe_data.get(
            key,  {"pages_with_violations": 0, "violations_by_impact": {}})
        refl = reflow_data.get(
            key, {"pages_with_overflow": 0, "total_overflow_px": 0})
        lang = lang_data.get(key)

        s_axe = score_axe(axe["pages_with_violations"], pg)
        s_ref = score_reflow(refl["pages_with_overflow"], pg)
        s_lang = score_language(lang["avg_flesch_kincaid"]) if lang else 100.0

        if has_focus:
            focus = focus_data.get(
                key, {"pages_with_issues": 0, "total_issues": 0})
            s_foc = score_focus(focus["pages_with_issues"], pg)
        else:
            focus = {"pages_with_issues": 0, "total_issues": 0}
            s_foc = None

        s_ov = overall_score(s_axe, s_foc, s_ref, s_lang)

        sites_dict[base_url] = {
            "organisation":  org,
            "sector":        org_sector.get(org, "Unknown"),
            "pages_scanned": pg,
            "scores": {
                "overall":         s_ov,
                "axe_core":        s_axe,
                "focus_indicator": s_foc,
                "reflow":          s_ref,
                "language":        s_lang,
            },
            "details": {
                "axe_core":       {"pages_with_violations": axe["pages_with_violations"],
                                   "violations_by_impact":  axe["violations_by_impact"]},
                "focus_indicator": focus,
                "reflow":          refl,
                "language":        lang or {},
            },
        }

        ob = org_buckets[org]
        ob["sites"].append(base_url)
        ob["pages"] += pg
        ob["axe_violated"] += axe["pages_with_violations"]
        for imp, cnt in axe["violations_by_impact"].items():
            ob["axe_impacts"][imp] += cnt
        if has_focus:
            ob["focus_pages"] += focus["pages_with_issues"]
            ob["focus_total"] += focus["total_issues"]
        ob["reflow_pages"] += refl["pages_with_overflow"]
        ob["reflow_px"] += refl["total_overflow_px"]
        if lang:
            ob["lang_fk_sum"] += lang["avg_flesch_kincaid"] * lang["page_count"]
            ob["lang_smog_sum"] += lang["avg_smog"] * lang["page_count"]
            ob["lang_count"] += lang["page_count"]

    # Build org-level records
    orgs_dict = {}
    for org, ob in sorted(org_buckets.items()):
        pg = ob["pages"]

        axe_s = score_axe(ob["axe_violated"],  pg)
        refl_s = score_reflow(ob["reflow_pages"], pg)

        lc = ob["lang_count"]
        if lc > 0:
            avg_fk = ob["lang_fk_sum"] / lc
            avg_smog = ob["lang_smog_sum"] / lc
            lang_s = score_language(avg_fk)
        else:
            avg_fk = avg_smog = 0.0
            lang_s = 100.0

        focus_s = score_focus(ob["focus_pages"], pg) if has_focus else None
        ov = overall_score(axe_s, focus_s, refl_s, lang_s)

        orgs_dict[org] = {
            "sector":        org_sector.get(org, "Unknown"),
            "sites":         ob["sites"],
            "pages_scanned": pg,
            "scores": {
                "overall":         ov,
                "axe_core":        axe_s,
                "focus_indicator": focus_s,
                "reflow":          refl_s,
                "language":        lang_s,
            },
            "details": {
                "axe_core": {
                    "pages_with_violations": ob["axe_violated"],
                    "violations_by_impact":  dict(ob["axe_impacts"]),
                },
                "focus_indicator": {
                    "pages_with_issues": ob["focus_pages"],
                    "total_issues":      ob["focus_total"],
                },
                "reflow": {
                    "pages_with_overflow": ob["reflow_pages"],
                    "total_overflow_px":   ob["reflow_px"],
                },
                "language": {
                    "avg_flesch_kincaid": round(avg_fk,   2),
                    "avg_smog":           round(avg_smog, 2),
                    "pages_analyzed":     lc,
                } if lc > 0 else {},
            },
        }

    return sites_dict, orgs_dict


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    scans = discover_scans()
    if not scans:
        print("ERROR: No scan directories found. "
              "Expected YYYY-MM-DD_quarterly_cwac_scan/ directories.")
        return

    print(f"Discovered {len(scans)} scan(s): {[d for d, _ in scans]}")

    # Process every scan
    all_scan_data = {}   # date → (sites_dict, orgs_dict)
    for date, scan_dir in scans:
        print(f"\nProcessing scan {date} …")
        sites_d, orgs_d = process_scan(date, scan_dir)
        all_scan_data[date] = (sites_d, orgs_d)

    latest_date = scans[0][0]
    past_dates = [d for d, _ in scans[1:]]   # all except latest

    curr_sites, curr_orgs = all_scan_data[latest_date]

    # ── Build meta.scans list ──────────────────────────────────────────
    scan_meta = []
    for date, _ in scans:
        has_focus = any(
            o["scores"]["focus_indicator"] is not None
            for o in all_scan_data[date][1].values()
        )
        scan_meta.append({"date": date, "focus_available": has_focus})

    # ── Attach history to orgs ─────────────────────────────────────────
    organisations = []
    for name, rec in curr_orgs.items():
        history = {}
        for past_date in past_dates:
            past_orgs = all_scan_data[past_date][1]
            if name in past_orgs:
                history[past_date] = {"scores": past_orgs[name]["scores"]}
        rec["history"] = history
        rec["name"] = name
        organisations.append(rec)

    organisations.sort(key=lambda o: o["scores"]["overall"], reverse=True)
    for i, o in enumerate(organisations):
        o["rank"] = i + 1

    # ── Attach history to sites ────────────────────────────────────────
    all_sites = []
    for base_url, rec in curr_sites.items():
        history = {}
        for past_date in past_dates:
            past_sites = all_scan_data[past_date][0]
            if base_url in past_sites:
                history[past_date] = {"scores": past_sites[base_url]["scores"]}
        rec["history"] = history
        rec["base_url"] = base_url
        all_sites.append(rec)

    all_sites.sort(key=lambda s: s["scores"]["overall"], reverse=True)
    for i, s in enumerate(all_sites):
        s["rank"] = i + 1

    has_focus_curr = scan_meta[0]["focus_available"]

    # ── Carry forward most-recent focus data if latest scan lacks it ──────
    focus_backfill_date = None
    if not has_focus_curr:
        for past_date in past_dates:
            if any(o["scores"]["focus_indicator"] is not None
                   for o in all_scan_data[past_date][1].values()):
                focus_backfill_date = past_date
                break

    if focus_backfill_date:
        past_orgs_bf = all_scan_data[focus_backfill_date][1]
        past_sites_bf = all_scan_data[focus_backfill_date][0]
        for org in organisations:
            past = past_orgs_bf.get(org["name"])
            if past and past["scores"]["focus_indicator"] is not None:
                org["scores"]["focus_indicator"] = past["scores"]["focus_indicator"]
                org["details"]["focus_indicator"] = past["details"]["focus_indicator"]
                org["focus_indicator_from_date"] = focus_backfill_date
        for site in all_sites:
            past = past_sites_bf.get(site["base_url"])
            if past and past["scores"]["focus_indicator"] is not None:
                site["scores"]["focus_indicator"] = past["scores"]["focus_indicator"]
                site["details"]["focus_indicator"] = past["details"]["focus_indicator"]
                site["focus_indicator_from_date"] = focus_backfill_date
    # ── Assemble final JSON ────────────────────────────────────────────
    sectors = sorted({o["sector"] for o in organisations})

    output = {
        "meta": {
            "latest_scan":          latest_date,
            "generated_at":         datetime.now().isoformat(),
            "total_organisations":  len(organisations),
            "total_sites":          len(all_sites),
            "total_pages":          sum(o["pages_scanned"] for o in organisations),
            "scans":                scan_meta,
            "focus_data_available": has_focus_curr or (focus_backfill_date is not None),
            "focus_latest_scan": focus_backfill_date if (not has_focus_curr and focus_backfill_date) else latest_date,
            "scoring_weights": {
                "axe_core":        0.40,
                "focus_indicator": 0.30 if has_focus_curr else None,
                "reflow":          0.20,
                "language":        0.10,
            },
            "scoring_notes": {
                "axe_core":        "% pages with zero WCAG violations (via axe-core, template-deduplicated)",
                "focus_indicator": "% pages with all interactive elements showing a visible focus ring"
                                   + ("" if has_focus_curr
                                      else f" (scores from {focus_backfill_date} scan — not included in latest overall)"
                                      if focus_backfill_date
                                      else " (not available for any scan)"),
                "reflow":          "% pages with no horizontal overflow at 320px viewport width",
                "language":        "Flesch-Kincaid grade ≤8 scores 100; −5 pts per grade above 8",
            },
        },
        "sectors":       sectors,
        "organisations": organisations,
        "sites":         all_sites,
    }

    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = os.path.join(OUT_DIR, "leaderboard.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\nGenerated {out_path}")
    print(f"  Scans included : {[s['date'] for s in scan_meta]}")
    print(f"  Organisations  : {len(organisations)}")
    print(f"  Total sites    : {len(all_sites)}")
    print(
        f"  Total pages    : {sum(o['pages_scanned'] for o in organisations)}")
    print(
        f"  Focus data     : {'yes' if has_focus_curr else 'NO (weights renormalised)'}")

    print("\nTop 10 (latest scan):")
    for o in organisations[:10]:
        foc_str = (f"{o['scores']['focus_indicator']:5.1f}"
                   if o["scores"]["focus_indicator"] is not None else "  N/A")
        print(f"  {o['rank']:2d}. {o['name'][:42]:<42s}"
              f"  ov={o['scores']['overall']:5.1f}"
              f"  axe={o['scores']['axe_core']:5.1f}"
              f"  foc={foc_str}"
              f"  ref={o['scores']['reflow']:5.1f}"
              f"  lng={o['scores']['language']:5.1f}"
              f"  history=[{', '.join(o['history'].keys())}]")


if __name__ == "__main__":
    main()
