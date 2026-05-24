/**
 * app.js — NZ Government Accessibility Leaderboard
 * Reads data/leaderboard.json and renders a sortable, filterable table.
 */

// ── Scoring constants ──────────────────────────────────────────────────────────────────────────────
/**
 * Score band thresholds (0–100). Raise or lower these to adjust the
 * Great / Good / Fair / Poor bands without touching any rendering logic.
 */
const SCORE_THRESHOLDS = Object.freeze({ GREAT: 90, GOOD: 75, FAIR: 50 });

const TAB_CONFIG = [
    {
        id: "overall",
        label: "Overall Score",
        icon: "",
        description: "Weighted composite of all four audit categories",
        field: "scores.overall",
        columns: ["rank", "organisation", "sector", "pages", "overall", "axe_core", "focus", "reflow", "language"],
    },
    {
        id: "axe_core",
        label: "Axe Core (WCAG)",
        icon: "",
        description: "% of pages with zero WCAG violations (axe-core, template-deduplicated)",
        field: "scores.axe_core",
        columns: ["rank", "organisation", "sector", "pages", "axe_core", "pages_with_violations", "impact_breakdown"],
    },
    {
        id: "focus_indicator",
        label: "Focus Indicator",
        icon: "",
        description: "% of pages where all interactive elements show a visible focus ring (WCAG 2.4.11)",
        field: "scores.focus_indicator",
        columns: ["rank", "organisation", "sector", "pages", "focus", "focus_pages", "focus_issues"],
    },
    {
        id: "reflow",
        label: "Reflow",
        icon: "",
        description: "% of pages with no horizontal overflow at 320 px viewport width (WCAG 1.4.10)",
        field: "scores.reflow",
        columns: ["rank", "organisation", "sector", "pages", "reflow", "reflow_pages"],
    },
    {
        id: "language",
        label: "Language",
        icon: "",
        description: "Flesch-Kincaid readability grade — NZ Gov target is grade 8 or below",
        field: "scores.language",
        columns: ["rank", "organisation", "sector", "pages", "language", "fk_grade", "smog_grade"],
    },
];

//  State
let allData = null;
let filtered = [];
let sortField = "scores.overall";
let sortAsc = false;
let activeTab = "overall";
let activeSector = "all";
let activeView = "orgs";  // "orgs" | "sites"
let activeOrgFilter = "all";   // org name filter used in sites view
let searchQuery = "";
let selectedKey = null;    // org.name in orgs view, site.base_url in sites view
let detailOpenerEl = null; // element that triggered the detail panel (for focus return)
let comparisonDate = null; // which past scan date to diff against
let colorblindMode = false; // colourblind-friendly colour palette

//  Boot
document.addEventListener("DOMContentLoaded", () => {
    initTabs();
    initControls();
    loadData();
});

/**
 * Fetches leaderboard.json, seeds the comparison date from the most-recent
 * past scan, populates all dropdowns and header stats, then triggers the
 * initial render. Displays an error state if the fetch fails.
 */
async function loadData() {
    showLoading();
    try {
        const res = await fetch("data/leaderboard.json");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        allData = await res.json();
        // Default comparison = most-recent past scan (index 1 in meta.scans)
        comparisonDate = allData.meta.scans[1]?.date ?? null;
        populateSectorFilter();
        populateOrgFilter();
        populateComparisonSelect();
        populateHeaderMeta();
        applyFiltersAndRender();
    } catch (err) {
        showError(err);
    }
}

//  Header meta
/**
 * Writes the summary counts (organisations, sites, pages, scan date) into
 * the header meta bar.
 */
function populateHeaderMeta() {
    const m = allData.meta;
    document.getElementById("meta-orgs").textContent = m.total_organisations;
    document.getElementById("meta-sites").textContent = m.total_sites;
    document.getElementById("meta-pages").textContent = m.total_pages.toLocaleString();
    document.getElementById("meta-date").textContent = formatDate(m.latest_scan);
}

//  Comparison scan selector
/**
 * Builds the "Compare to" dropdown with one option per past CWAC scan.
 * Options for scans missing focus data are labelled accordingly.
 * Hides the control entirely if there are no past scans available.
 */
function populateComparisonSelect() {
    const sel = document.getElementById("comparison-select");
    if (!sel) return;
    // Clear existing options beyond the first placeholder
    while (sel.options.length > 1) sel.remove(1);
    // Add one option per past scan
    const past = allData.meta.scans.slice(1);
    past.forEach(s => {
        const opt = document.createElement("option");
        opt.value = s.date;
        opt.textContent = formatDate(s.date) + (s.focus_available ? "" : " (no focus data)");
        if (s.date === comparisonDate) opt.selected = true;
        sel.appendChild(opt);
    });
    // Show/hide based on whether any past scans exist
    const wrap = document.getElementById("comparison-wrap");
    if (wrap) wrap.hidden = past.length === 0;
}

/**
 * Converts an ISO date string (YYYY-MM-DD) to a human-readable NZ date,
 * e.g. "30 June 2025".
 * @param {string} iso - ISO 8601 date string.
 * @returns {string} Localised date string.
 */
function formatDate(iso) {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" });
}

//  Sector filter
/**
 * Appends one `<option>` per sector to the sector filter `<select>`.
 */
function populateSectorFilter() {
    const sel = document.getElementById("sector-filter");
    allData.sectors.forEach(s => {
        const opt = document.createElement("option");
        opt.value = s;
        opt.textContent = s;
        sel.appendChild(opt);
    });
}

/**
 * Appends one `<option>` per organisation to the org filter `<select>` used
 * in the sites view.
 */
function populateOrgFilter() {
    const sel = document.getElementById("org-filter");
    const names = [...new Set(allData.sites.map(s => s.organisation))].sort();
    names.forEach(n => {
        const opt = document.createElement("option");
        opt.value = n;
        opt.textContent = n;
        sel.appendChild(opt);
    });
}
//  Tabs
/**
 * Renders the five category tab buttons and wires up click and arrow-key
 * navigation following the ARIA Authoring Practices Guide tablist pattern.
 */
function initTabs() {
    const container = document.getElementById("category-tabs");
    TAB_CONFIG.forEach(tab => {
        const btn = document.createElement("button");
        btn.className = "tab-btn" + (tab.id === activeTab ? " active" : "");
        btn.dataset.tab = tab.id;
        btn.id = "tab-" + tab.id;
        btn.setAttribute("role", "tab");
        btn.setAttribute("aria-selected", tab.id === activeTab ? "true" : "false");
        btn.setAttribute("aria-controls", "leaderboard-panel");
        btn.setAttribute("tabindex", tab.id === activeTab ? "0" : "-1");
        btn.textContent = tab.label;
        btn.addEventListener("click", () => switchTab(tab.id));
        container.appendChild(btn);
    });
    // Arrow-key navigation within the tablist (ARIA APG pattern)
    container.addEventListener("keydown", e => {
        const tabs = [...container.querySelectorAll(".tab-btn")];
        const idx = tabs.findIndex(t => t === document.activeElement);
        if (idx === -1) return;
        let next = -1;
        if (e.key === "ArrowRight") next = (idx + 1) % tabs.length;
        else if (e.key === "ArrowLeft") next = (idx - 1 + tabs.length) % tabs.length;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = tabs.length - 1;
        if (next !== -1) {
            e.preventDefault();
            tabs[next].focus();
            switchTab(tabs[next].dataset.tab);
        }
    });
}

/**
 * Activates the given tab: updates ARIA state on all tab buttons, resets
 * sort to the tab's primary field, and re-renders the table.
 * @param {string} tabId - One of the TAB_CONFIG `id` values.
 */
function switchTab(tabId) {
    activeTab = tabId;
    const tabCfg = TAB_CONFIG.find(t => t.id === tabId);
    sortField = tabCfg.field;
    sortAsc = false;

    document.querySelectorAll(".tab-btn").forEach(b => {
        const isActive = b.dataset.tab === tabId;
        b.classList.toggle("active", isActive);
        b.setAttribute("aria-selected", isActive ? "true" : "false");
        b.setAttribute("tabindex", isActive ? "0" : "-1");
    });

    const panel = document.getElementById("leaderboard-panel");
    if (panel) panel.setAttribute("aria-labelledby", "tab-" + tabId);

    applyFiltersAndRender();
}

//  Controls
/**
 * Attaches event listeners to all filter, sort, and toggle controls.
 * Also restores the colourblind mode preference from localStorage.
 */
function initControls() {
    document.getElementById("search-input").addEventListener("input", e => {
        searchQuery = e.target.value.trim().toLowerCase();
        applyFiltersAndRender();
    });

    document.getElementById("sector-filter").addEventListener("change", e => {
        activeSector = e.target.value;
        applyFiltersAndRender();
    });

    document.getElementById("org-filter").addEventListener("change", e => {
        activeOrgFilter = e.target.value;
        applyFiltersAndRender();
    });

    document.getElementById("comparison-select")?.addEventListener("change", e => {
        comparisonDate = e.target.value || null;
        applyFiltersAndRender();
    });

    const cbToggle = document.getElementById("colorblind-toggle");
    cbToggle?.addEventListener("click", () => {
        colorblindMode = !colorblindMode;
        document.documentElement.classList.toggle("colorblind", colorblindMode);
        cbToggle.setAttribute("aria-pressed", colorblindMode ? "true" : "false");
        localStorage.setItem("colorblindMode", colorblindMode);
        applyFiltersAndRender();
    });
    // Restore saved preference
    if (localStorage.getItem("colorblindMode") === "true") {
        colorblindMode = true;
        document.documentElement.classList.add("colorblind");
        cbToggle?.setAttribute("aria-pressed", "true");
    }

    document.querySelectorAll(".view-toggle-btn").forEach(btn => {
        btn.setAttribute("aria-pressed", btn.dataset.view === activeView ? "true" : "false");
        btn.addEventListener("click", () => switchView(btn.dataset.view));
    });

    document.getElementById("detail-overlay").addEventListener("click", e => {
        if (e.target === document.getElementById("detail-overlay")) closeDetail();
    });

    document.getElementById("detail-close").addEventListener("click", closeDetail);

    // Escape key closes detail panel
    document.addEventListener("keydown", e => {
        if (e.key === "Escape" && document.getElementById("detail-overlay").classList.contains("open")) {
            closeDetail();
        }
    });
}

/**
 * Switches between the organisations and sites views, resetting filters,
 * search query, and sort state before re-rendering.
 * @param {"orgs"|"sites"} view - The view to activate.
 */
function switchView(view) {
    activeView = view;
    activeOrgFilter = "all";
    searchQuery = "";
    selectedKey = null;
    document.getElementById("search-input").value = "";
    document.getElementById("org-filter").value = "all";

    document.querySelectorAll(".view-toggle-btn").forEach(b => {
        const isActive = b.dataset.view === view;
        b.classList.toggle("active", isActive);
        b.setAttribute("aria-pressed", isActive ? "true" : "false");
    });

    // Update search placeholder to match view
    document.getElementById("search-input").placeholder =
        view === "sites" ? "Search sites…" : "Search organisations…";

    // Show/hide the org filter (only relevant in site view)
    const orgFilterWrap = document.getElementById("org-filter-wrap");
    orgFilterWrap.hidden = (view === "orgs");

    // Reset sort to overall
    const tabCfg = TAB_CONFIG.find(t => t.id === activeTab);
    sortField = tabCfg.field;
    sortAsc = false;

    applyFiltersAndRender();
}

//  Filtering & sorting
/**
 * Returns the currently active data array (organisations or sites) based
 * on the `activeView` state variable.
 * @returns {Array} The active dataset from `allData`.
 */
function activeDataset() {
    return activeView === "sites" ? allData.sites : allData.organisations;
}

/**
 * Filters the active dataset against the current sector, org, and search
 * criteria, sorts the result by the active column, then calls `renderTable()`.
 * No-ops silently if data has not yet loaded.
 */
function applyFiltersAndRender() {
    if (!allData) return;

    const dataset = activeDataset();
    const isSites = activeView === "sites";

    filtered = dataset.filter(item => {
        const sector = item.sector;
        const searchTarget = isSites
            ? (item.base_url + " " + item.organisation).toLowerCase()
            : item.name.toLowerCase();
        if (activeSector !== "all" && sector !== activeSector) return false;
        if (isSites && activeOrgFilter !== "all" && item.organisation !== activeOrgFilter) return false;
        if (searchQuery && !searchTarget.includes(searchQuery)) return false;
        return true;
    });

    filtered.sort((a, b) => {
        const av = getNestedVal(a, sortField);
        const bv = getNestedVal(b, sortField);
        return sortAsc ? av - bv : bv - av;
    });

    renderTable();
}

/**
 * Reads a value from a nested object using dot notation.
 * Returns 0 (rather than null/undefined) so numeric sort comparisons work.
 * @param {object} obj  - The object to traverse.
 * @param {string} path - Dot-separated key path, e.g. `"scores.overall"`.
 * @returns {number} The resolved value, or 0 if the path is not found.
 */
function getNestedVal(obj, path) {
    return path.split(".").reduce((o, k) => (o == null ? null : o[k]), obj) ?? 0;
}

//  Table rendering
/**
 * Rebuilds the table header, rows, caption, and info bar to reflect the
 * current tab, view, and filtered/sorted dataset. Wires up row click and
 * keyboard handlers for the detail panel. Restores the selected-row
 * highlight when the detail panel is already open.
 */
function renderTable() {
    const tabCfg = TAB_CONFIG.find(t => t.id === activeTab);
    const tbody = document.getElementById("table-body");
    const thead = document.getElementById("table-head");
    const info = document.getElementById("table-info");
    const desc = document.getElementById("tab-description");

    desc.textContent = tabCfg.description;
    if (activeTab === "focus_indicator" && allData?.meta.focus_data_available === false) {
        desc.insertAdjacentHTML(
            "beforeend",
            ` — <strong style="color:var(--color-score-fair)">Focus indicator audit data was not included in this quarterly CWAC scan, so all scores show N/A.</strong>`
        );
    }
    const caption = document.getElementById("table-caption");
    if (caption) caption.textContent = `${tabCfg.label} — ${activeView === "sites" ? "Sites" : "Organisations"} leaderboard`;
    const total = activeDataset().length;
    const unit = activeView === "sites" ? "sites" : "organisations";
    info.textContent = `Showing ${filtered.length} of ${total} ${unit}`;

    // Build header
    thead.innerHTML = buildHeaderHTML(tabCfg);

    // Attach sort listeners
    thead.querySelectorAll("th.sortable").forEach(th => {
        th.addEventListener("click", () => {
            const field = th.dataset.field;
            if (sortField === field) {
                sortAsc = !sortAsc;
            } else {
                sortField = field;
                sortAsc = false;
            }
            applyFiltersAndRender();
        });
    });

    // Build rows
    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10">
      <div class="state-empty">

        <div class="state-empty-text">No ${activeView === "sites" ? "sites" : "organisations"} match your filters</div>
      </div></td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map((item, idx) => buildRowHTML(item, idx + 1, tabCfg)).join("");

    // Row click + keyboard activation
    tbody.querySelectorAll("tr[data-key]").forEach(row => {
        row.addEventListener("click", () => openDetail(row.dataset.key));
        row.addEventListener("keydown", e => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openDetail(row.dataset.key);
            }
        });
    });

    // Highlight selected
    if (selectedKey) {
        tbody.querySelectorAll("tr[data-key]").forEach(r => {
            r.classList.toggle("selected", r.dataset.key === selectedKey);
        });
    }
}

//  Header HTML
/**
 * Generates the `<thead><tr>` HTML string for the given tab configuration,
 * including sortable column headers with ARIA sort attributes and
 * directional indicators.
 * @param {object} tabCfg - A TAB_CONFIG entry for the active tab.
 * @returns {string} Inner HTML for the `<thead>` element.
 */
function buildHeaderHTML(tabCfg) {
    const cols = tabCfg.columns;
    const defs = {
        rank: { label: "#", sortable: false },
        organisation: { label: activeView === "sites" ? "Site" : "Organisation", sortable: false },
        sector: { label: "Sector", sortable: false },
        pages: { label: "Pages", sortable: false },
        overall: { label: "Overall", field: "scores.overall", sortable: true },
        axe_core: { label: "Axe Core", field: "scores.axe_core", sortable: true },
        focus: { label: "Focus", field: "scores.focus_indicator", sortable: true },
        reflow: { label: "Reflow", field: "scores.reflow", sortable: true },
        language: { label: "Language", field: "scores.language", sortable: true },
        pages_with_violations: { label: "Pages w/ Violations", sortable: false },
        impact_breakdown: { label: "Violations by Impact", sortable: false },
        focus_pages: { label: "Pages w/ Issues", sortable: false },
        focus_issues: { label: "Total Issues", sortable: false },
        reflow_pages: { label: "Pages Overflowed", sortable: false },
        fk_grade: { label: "FK Grade", field: "details.language.avg_flesch_kincaid", sortable: true },
        smog_grade: { label: "SMOG Grade", field: "details.language.avg_smog", sortable: true },
    };

    return "<tr>" + cols.map(c => {
        const d = defs[c];
        if (!d) return "";
        const isActive = d.sortable && sortField === d.field;
        const arrow = isActive ? (sortAsc ? "▲" : "▼") : "▲";
        const classes = ["th-" + c, d.sortable ? "sortable" : "", isActive ? "sort-active" : ""].filter(Boolean).join(" ");
        const dataField = d.field ? `data-field="${d.field}"` : "";
        const ariaSort = d.sortable
            ? (isActive ? (sortAsc ? `aria-sort="ascending"` : `aria-sort="descending"`) : `aria-sort="none"`)
            : "";
        return `<th class="${classes}" ${dataField} scope="col" ${ariaSort}>${d.label}${d.sortable ? `<i class="sort-icon" aria-hidden="true">${arrow}</i>` : ""}</th>`;
    }).join("") + "</tr>";
}

//  Delta helper
/**
 * Computes per-score deltas between the current scan and `comparisonDate`
 * for a given organisation or site record. Returns null if no comparison
 * date is selected or the record has no history entry for that date.
 * @param {object} record - An organisation or site object from `allData`.
 * @returns {{ overall: number|null, axe_core: number|null, focus_indicator: number|null, reflow: number|null, language: number|null }|null}
 */
function computeDeltas(record) {
    if (!comparisonDate || !record.history?.[comparisonDate]) return null;
    const prev = record.history[comparisonDate].scores;
    const curr = record.scores;
    const keys = ["overall", "axe_core", "focus_indicator", "reflow", "language"];
    const delta = {};
    keys.forEach(k => {
        delta[k] = (curr[k] != null && prev[k] != null)
            ? Math.round((curr[k] - prev[k]) * 10) / 10
            : null;
    });
    return delta;
}

//  Row HTML
/**
 * Generates the `<tr>` HTML string for a single organisation or site row,
 * including score badges, mini-bars, delta indicators, and a descriptive
 * ARIA label for screen readers.
 * @param {object} item        - Organisation or site record from `allData`.
 * @param {number} displayRank - 1-based position in the filtered/sorted list.
 * @param {object} tabCfg      - A TAB_CONFIG entry for the active tab.
 * @returns {string} A `<tr>` element as an HTML string.
 */
function buildRowHTML(item, displayRank, tabCfg) {
    const cols = tabCfg.columns;
    const rank = item.rank;
    const d = item.details;
    const scores = item.scores;
    const isSite = activeView === "sites";
    const key = isSite ? item.base_url : item.name;
    const dv = computeDeltas(item) || {};

    const rankClass = rank === 1 ? "gold" : rank === 2 ? "silver" : rank === 3 ? "bronze" : "";

    const orgCell = isSite
        ? `<td>
            <div class="org-name site-url" title="${escapeHtml(item.base_url)}">${escapeHtml(item.base_url.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</div>
            <div class="org-sites">${escapeHtml(item.organisation)}</div>
          </td>`
        : `<td>
            <div class="org-name">${escapeHtml(item.name)}</div>
            <div class="org-sites">${item.sites.length} site${item.sites.length !== 1 ? "s" : ""}</div>
          </td>`;

    const cellMap = {
        rank: `<td><div class="rank-cell ${rankClass}">${rank}</div></td>`,
        organisation: orgCell,
        sector: `<td><span class="sector-badge">${abbreviateSector(item.sector)}</span></td>`,
        pages: `<td>${item.pages_scanned.toLocaleString()}</td>`,
        overall: `<td>${scoreBadge(scores.overall, dv.overall)}</td>`,
        axe_core: `<td>${miniBar(scores.axe_core, dv.axe_core)}</td>`,
        focus: `<td>${miniBar(scores.focus_indicator, dv.focus_indicator)}</td>`,
        reflow: `<td>${miniBar(scores.reflow, dv.reflow)}</td>`,
        language: `<td>${miniBar(scores.language, dv.language)}</td>`,

        pages_with_violations: `<td style="font-family:var(--font-mono)">${d.axe_core.pages_with_violations.toLocaleString()}</td>`,
        impact_breakdown: `<td>${impactCapsules(d.axe_core.violations_by_impact)}</td>`,
        focus_pages: `<td style="font-family:var(--font-mono)">${d.focus_indicator.pages_with_issues.toLocaleString()}</td>`,
        focus_issues: `<td style="font-family:var(--font-mono)">${d.focus_indicator.total_issues.toLocaleString()}</td>`,
        reflow_pages: `<td style="font-family:var(--font-mono)">${d.reflow.pages_with_overflow.toLocaleString()}</td>`,
        fk_grade: `<td style="font-family:var(--font-mono)">${d.language.avg_flesch_kincaid != null ? d.language.avg_flesch_kincaid.toFixed(1) : "—"}</td>`,
        smog_grade: `<td style="font-family:var(--font-mono)">${d.language.avg_smog != null ? d.language.avg_smog.toFixed(1) : "—"}</td>`,
    };

    const rowLabel = isSite
        ? `${item.base_url.replace(/^https?:\/\//, "").replace(/\/$/, "")}, ${item.organisation}, rank ${rank}, overall score ${scores.overall !== null ? scores.overall.toFixed(1) : "not available"}`
        : `${item.name}, ${item.sector}, rank ${rank}, overall score ${scores.overall !== null ? scores.overall.toFixed(1) : "not available"}`;
    const cells = cols.map(c => cellMap[c] || "<td>—</td>").join("");
    return `<tr data-key="${escapeHtml(key)}" tabindex="0" aria-label="${escapeHtml(rowLabel)}">${cells}</tr>`;
}

//  Score helpers
/**
 * Maps a numeric score to a CSS class name used for badge and bar colouring.
 * @param {number} v - Score value (0–100).
 * @returns {"great"|"good"|"fair"|"poor"}
 */
function scoreClass(v) {
    if (v >= SCORE_THRESHOLDS.GREAT) return "great";
    if (v >= SCORE_THRESHOLDS.GOOD) return "good";
    if (v >= SCORE_THRESHOLDS.FAIR) return "fair";
    return "poor";
}

/**
 * Returns the hex text colour for a score value, automatically switching
 * to the colourblind-friendly palette (blue/teal/orange/violet) when
 * `colorblindMode` is active.
 * @param {number} v - Score value (0–100).
 * @returns {string} Hex colour string.
 */
function scoreColor(v) {
    if (colorblindMode) {
        const cb = { great: "#1e3a8a", good: "#134e4a", fair: "#9a3412", poor: "#4c1d95" };
        return cb[scoreClass(v)];
    }
    const map = { great: "#166534", good: "#92400e", fair: "#9a3412", poor: "#991b1b" };
    return map[scoreClass(v)];
}

/**
 * Renders a small inline badge showing a score change (+/−) with an
 * accessible ARIA label. Returns an empty string when no delta is available.
 * @param {number|null} d - Delta value (positive = improvement).
 * @returns {string} An HTML `<span>` badge, or `""`.
 */
function deltaBadge(d) {
    if (d === null || d === undefined) return "";
    if (d === 0) return `<span class="delta delta-zero" aria-label="no change">±0</span>`;
    const sign = d > 0 ? "+" : "";
    const cls = d > 0 ? "delta-up" : "delta-down";
    const label = d > 0
        ? `improved by ${d.toFixed(1)} points`
        : `declined by ${Math.abs(d).toFixed(1)} points`;
    return `<span class="delta ${cls}" aria-label="${label}">${sign}${d.toFixed(1)}</span>`;
}

/**
 * Renders a coloured score badge pill with an optional delta indicator.
 * Shows "N/A" for null/undefined values.
 * @param {number|null} v - Score value, or null.
 * @param {number|null} d - Delta from `computeDeltas()`, or null.
 * @returns {string} HTML string.
 */
function scoreBadge(v, d) {
    if (v === null || v === undefined)
        return `<span class="score-badge score-na">N/A</span>`;
    return `<span class="score-badge score-${scoreClass(v)}">${v.toFixed(1)}</span>${deltaBadge(d)}`;
}

/**
 * Renders a horizontal mini progress bar whose width is proportional to the
 * score (0–100 %), with the numeric value alongside and an optional delta badge.
 * @param {number|null} v - Score value, or null.
 * @param {number|null} d - Delta from `computeDeltas()`, or null.
 * @returns {string} HTML string.
 */
function miniBar(v, d) {
    if (v === null || v === undefined)
        return `<span style="color:var(--color-text-muted);font-size:12px">N/A</span>`;
    const cls = scoreClass(v);
    const color = scoreColor(v);
    return `<div class="mini-bar-wrap">
    <div class="mini-bar-bg"><div class="mini-bar-fill" style="width:${v}%;background:${color}"></div></div>
    <span class="mini-val" style="color:${color}">${v.toFixed(0)}</span>
  </div>${deltaBadge(d)}`;
}

/**
 * Renders a row of inline coloured capsules summarising WCAG violation counts
 * by axe-core impact level (critical → serious → moderate → minor).
 * Colours respect the active colourblind mode palette.
 * @param {{ critical?: number, serious?: number, moderate?: number, minor?: number, unknown?: number }|null} byImpact
 * @returns {string} HTML string.
 */
function impactCapsules(byImpact) {
    if (!byImpact || !Object.keys(byImpact).length) return '<span style="color:#94a3b8">—</span>';
    const order = ["critical", "serious", "moderate", "minor", "unknown"];
    const colors = colorblindMode
        ? { critical: "#4c1d95", serious: "#9a3412", moderate: "#134e4a", minor: "#64748b", unknown: "#5c6570" }
        : { critical: "#991b1b", serious: "#9a3412", moderate: "#92400e", minor: "#64748b", unknown: "#5c6570" };
    return order
        .filter(k => byImpact[k])
        .map(k => `<span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:600;color:${colors[k]};margin-right:6px">
      <span style="width:6px;height:6px;border-radius:50%;background:${colors[k]};display:inline-block"></span>${byImpact[k]}
    </span>`)
        .join("");
}

/**
 * Returns a shortened display label for long NZ public-sector category names
 * so they fit comfortably in a table cell.
 * @param {string} s - Full sector name from the data.
 * @returns {string} Abbreviated name, or the original string if no mapping exists.
 */
function abbreviateSector(s) {
    const abbr = {
        "Crown Entities - Crown Agents": "Crown Agents",
        "Crown Entities - Independent Crown Entities": "Independent CEs",
        "Non-Public Service Departments": "Non-PS Depts",
        "Public Service Departmental Agencies": "PS Dept Agencies",
        "Public Service Departments": "PS Departments",
        "Public Service Interdepartmental Executive Boards": "PS Exec Boards",
    };
    return abbr[s] || s;
}

//  Detail panel
/**
 * Opens the detail panel for the given key, populates it with score
 * breakdowns and audit statistics, then shifts keyboard focus to the
 * close button. Hides the page background from screen readers while open.
 * @param {string} key - Organisation name (orgs view) or base URL (sites view).
 */
function openDetail(key) {
    selectedKey = key;
    detailOpenerEl = document.activeElement;

    document.querySelectorAll("tr[data-key]").forEach(r => {
        r.classList.toggle("selected", r.dataset.key === key);
    });

    const isSite = activeView === "sites";
    const item = isSite
        ? allData.sites.find(s => s.base_url === key)
        : allData.organisations.find(o => o.name === key);
    if (!item) return;

    document.getElementById("detail-org-name").textContent = isSite
        ? item.base_url.replace(/^https?:\/\//, "").replace(/\/$/, "")
        : item.name;
    document.getElementById("detail-sector").textContent = isSite
        ? `${item.organisation} · ${item.sector}`
        : item.sector;

    document.getElementById("detail-content").innerHTML = buildDetailHTML(item, isSite);

    const overlay = document.getElementById("detail-overlay");
    overlay.classList.add("open");

    // Hide background from screen readers while dialog is open
    document.querySelector(".site-header").setAttribute("aria-hidden", "true");
    document.getElementById("main-content").setAttribute("aria-hidden", "true");

    document.addEventListener("keydown", trapFocus);
    document.getElementById("detail-close").focus();
}

/**
 * Closes the detail panel, clears the selected-row highlight, restores
 * ARIA visibility on the page background, and returns keyboard focus to
 * the element that originally triggered the panel.
 */
function closeDetail() {
    selectedKey = null;
    document.getElementById("detail-overlay").classList.remove("open");
    document.querySelectorAll("tr[data-key]").forEach(r => r.classList.remove("selected"));

    // Restore background to screen readers
    document.querySelector(".site-header").removeAttribute("aria-hidden");
    document.getElementById("main-content").removeAttribute("aria-hidden");

    document.removeEventListener("keydown", trapFocus);

    if (detailOpenerEl) {
        detailOpenerEl.focus();
        detailOpenerEl = null;
    }
}

/**
 * Keyboard event handler that constrains Tab focus to the focusable elements
 * inside the detail panel, cycling from the last back to the first and
 * vice versa (ARIA modal dialog pattern).
 * @param {KeyboardEvent} e
 */
function trapFocus(e) {
    if (e.key !== "Tab") return;
    const panel = document.getElementById("detail-panel");
    const focusable = [...panel.querySelectorAll(
        'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
        if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
        }
    } else {
        if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    }
}

/**
 * Generates the full inner HTML for the detail panel, including the overall
 * score circle, per-category breakdown bars and stat tiles, WCAG violation
 * impact list, language readability metrics, and a list of audited URLs.
 * @param {object}  item   - Organisation or site record from `allData`.
 * @param {boolean} [isSite=false] - Pass `true` when the active view is "sites".
 * @returns {string} HTML string to inject into `#detail-content`.
 */
function buildDetailHTML(item, isSite = false) {
    const s = item.scores;
    const dv = computeDeltas(item) || {};
    const d = item.details;
    const cls = s.overall !== null ? scoreClass(s.overall) : "na";

    const totalInDataset = isSite ? allData.sites.length : allData.organisations.length;

    const scoreRows = [
        { label: "Axe Core (WCAG)", val: s.axe_core, delta: dv.axe_core, weight: "40%" },
        { label: "Focus Indicator", val: s.focus_indicator, delta: dv.focus_indicator, weight: "30%" },
        { label: "Reflow", val: s.reflow, delta: dv.reflow, weight: "20%" },
        { label: "Language", val: s.language, delta: dv.language, weight: "10%" },
    ];

    // Sites section: for org view show all sites; for site view show just the one URL
    const siteUrls = isSite ? [item.base_url] : item.sites;
    const siteList = siteUrls
        .map(u => `<div class="site-chip"><a href="${u}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">${u}</a></div>`)
        .join("");

    const impactOrder = ["critical", "serious", "moderate", "minor", "unknown"];
    const impacts = d.axe_core.violations_by_impact;
    const impactHTML = impactOrder.filter(k => impacts[k]).map(k =>
        `<div class="impact-row">
      <span class="impact-dot ${k}"></span>
      <span class="impact-name">${k}</span>
      <span class="impact-count">${impacts[k].toLocaleString()}</span>
    </div>`
    ).join("") || '<span style="color:#94a3b8;font-size:12px">No violations recorded</span>';

    const langSection = (d.language && d.language.pages_analyzed > 0)
        ? `<div class="lang-grid">
        <div class="lang-metric">
          <div class="lang-metric-val">${d.language.avg_flesch_kincaid.toFixed(1)}</div>
          <div class="lang-metric-label">Flesch-Kincaid Grade</div>
        </div>
        <div class="lang-metric">
          <div class="lang-metric-val">${d.language.avg_smog.toFixed(1)}</div>
          <div class="lang-metric-label">SMOG Grade</div>
        </div>
      </div>
      <p style="font-size:11px;color:var(--color-text-muted);margin-top:8px">Based on ${d.language.pages_analyzed.toLocaleString()} pages. NZ Gov target: grade 8 or below.</p>`
        : '<p style="color:var(--color-text-muted);font-size:12px">No language data available</p>';

    return `
    <div class="detail-overall">
      <div class="score-circle ${cls}">
        <span class="score-circle-val">${s.overall !== null ? s.overall.toFixed(0) : "—"}</span>
        <span class="score-circle-label">Overall</span>
      </div>
      <div class="detail-overall-info">
        <div class="detail-rank">#${item.rank} <span style="font-size:14px;font-weight:400;color:var(--color-text-muted)">of ${totalInDataset}</span></div>
        <div class="detail-rank-label">Overall ranking</div>
        ${dv.overall != null ? `<div class="detail-delta-overall">${deltaBadge(dv.overall)} vs ${formatDate(comparisonDate)}</div>` : ""}
        <div class="detail-pages">${item.pages_scanned.toLocaleString()} pages scanned${isSite ? "" : ` across ${item.sites.length} site${item.sites.length !== 1 ? "s" : ""}`}</div>
      </div>
    </div>

    <div>
      <h2 class="detail-section-title">Score Breakdown</h2>
      ${scoreRows.map(r => {
        const isNull = r.val === null || r.val === undefined;
        const barW = isNull ? 0 : r.val;
        const color = isNull ? "var(--color-text-muted)" : scoreColor(r.val);
        const valStr = isNull ? "N/A" : r.val.toFixed(1);
        return `
        <div class="score-row">
          <div class="score-row-label">${r.label} <span style="font-size:10px;color:var(--color-text-muted)">(${r.weight})</span></div>
          <div class="score-row-bar-wrap">
            <div class="score-row-bar" style="width:${barW}%;background:${color}"></div>
          </div>
          <div class="score-row-val" style="color:${color}">${valStr}${deltaBadge(r.delta)}</div>
        </div>`;
    }).join("")}
    </div>

    <div>
      <h2 class="detail-section-title">Axe Core — WCAG Violations</h2>
      <div class="stat-grid" style="margin-bottom:10px">
        <div class="stat-tile">
          <div class="stat-tile-val" style="color:${scoreColor(s.axe_core)}">${d.axe_core.pages_with_violations.toLocaleString()}</div>
          <div class="stat-tile-label">Pages with violations</div>
        </div>
        <div class="stat-tile">
          <div class="stat-tile-val">${(item.pages_scanned - d.axe_core.pages_with_violations).toLocaleString()}</div>
          <div class="stat-tile-label">Clean pages</div>
        </div>
      </div>
      <div class="impact-list">${impactHTML}</div>
    </div>

    <div>
      <h2 class="detail-section-title">Focus Indicator</h2>
      ${s.focus_indicator !== null
            ? `<div class="stat-grid">
        <div class="stat-tile">
          <div class="stat-tile-val" style="color:${scoreColor(s.focus_indicator)}">${d.focus_indicator.pages_with_issues.toLocaleString()}</div>
          <div class="stat-tile-label">Pages with issues</div>
        </div>
        <div class="stat-tile">
          <div class="stat-tile-val">${d.focus_indicator.total_issues.toLocaleString()}</div>
          <div class="stat-tile-label">Total focus issues</div>
        </div>
      </div>`
            : `<p style="color:var(--color-text-muted);font-size:12px">Not available — focus indicator audit data was not included in this quarterly CWAC scan.</p>`
        }
    </div>

    <div>
      <h2 class="detail-section-title">Reflow (320 px viewport)</h2>
      <div class="stat-grid">
        <div class="stat-tile">
          <div class="stat-tile-val" style="color:${scoreColor(s.reflow)}">${d.reflow.pages_with_overflow.toLocaleString()}</div>
          <div class="stat-tile-label">Pages overflowed</div>
        </div>
        <div class="stat-tile">
          <div class="stat-tile-val">${d.reflow.total_overflow_px.toLocaleString()}</div>
          <div class="stat-tile-label">Total overflow (px)</div>
        </div>
      </div>
    </div>

    <div>
      <h2 class="detail-section-title">Language Readability</h2>
      ${langSection}
    </div>

    <div>
      <h2 class="detail-section-title">Sites Audited</h2>
      <div class="site-list">${siteList}</div>
    </div>
  `;
}

//  UI states
/**
 * Replaces the table body with an animated spinner while `leaderboard.json`
 * is being fetched.
 */
function showLoading() {
    document.getElementById("table-body").innerHTML = `<tr><td colspan="10">
    <div class="state-loading">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
      </svg>
      <div>Loading leaderboard data…</div>
    </div>
  </td></tr>`;
}

/**
 * Replaces the table body with an error message and a hint to run
 * `process_data.py` when data loading fails.
 * @param {Error|string} err - The caught error or error message.
 */
function showError(err) {
    document.getElementById("table-body").innerHTML = `<tr><td colspan="10">
    <div class="state-empty">

      <div class="state-empty-text">Failed to load data: ${escapeHtml(String(err))}<br>
        Run <code>python process_data.py</code> to generate the data file.</div>
    </div>
  </td></tr>`;
}

//  Utilities
/**
 * Escapes the characters `&`, `<`, `>`, and `"` in a string so it can be
 * safely interpolated into HTML without creating injection vulnerabilities.
 * @param {string} str - Raw input string.
 * @returns {string} HTML-safe string.
 */
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
