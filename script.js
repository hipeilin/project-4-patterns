const WINDOW_LENGTH = 31; // window_idx through window_idx + 30
const CHART_WIDTH = 300;
const CHART_HEIGHT = 100;
const MARGIN = { top: 10, right: 12, bottom: 26, left: 38 };
const DERIVED_METRIC_COLUMNS = [
  "max_consecutive_same_source",
  "max_consecutive_same_target",
  "tracing_count",
  "cycle_count",
  "max_consecutive_same_category",
  "sparsity"
];

const chartsContainer = d3.select("#charts");
const studentChartsContainer = d3.select("#student-charts");
const vizScrollEl = d3.select(".viz-scroll");
const stickyXScrollEl = d3.select("#sticky-x-scroll");
const stickyXScrollInnerEl = d3.select("#sticky-x-scroll-inner");
const statusEl = d3.select("#status");
const globalLegendEl = d3.select("#global-legend");
const tooltip = d3.select("#tooltip");
const motifSelectEl = d3.select("#motif-select");
const matchedDistanceSliderEl = d3.select("#matched-distance-slider");
const matchedDistanceValueEl = d3.select("#matched-distance-value");
const topKMotifSliderEl = d3.select("#topk-motif-slider");
const topKMotifValueEl = d3.select("#topk-motif-value");

const multiTsCache = new Map();
const studentCache = new Map();
let globalSeriesColumns = null;
let globalColorScale = null;
let currentRunId = 0;
let resetSlidersToMaxOnNextRun = false;
let isSyncingHorizontalScroll = false;
let matchedDistanceThreshold =
  Number(matchedDistanceSliderEl.property("value")) ||
  Number(matchedDistanceSliderEl.attr("max")) ||
  10;
let topKMotifs =
  Number(topKMotifSliderEl.property("value")) ||
  Number(topKMotifSliderEl.attr("max")) ||
  32;
const MOTIF_CSV_OPTIONS = ["motifs/motif_ed.csv", "motifs/motif_cos.csv", "motifs/motif_merged.csv"];

const categoryConfig = [
  { name: "atmosphere", items: ["slot_atmosphere"], color: "#87BFFF" },
  { name: "factory", items: ["slot_factory"], color: "#E07A5F" },
  {
    name: "surface",
    items: ["slot_plants", "slot_animals", "slot_decomposers_land", "slot_dead_land"],
    color: "#6A994E"
  },
  { name: "fossil_fuel", items: ["slot_fossil_fuel"], color: "#3A3A3A" },
  {
    name: "ocean",
    items: ["slot_carbon_dioxide", "slot_algae", "slot_fish", "slot_decomposers_ocean", "slot_dead_ocean"],
    color: "#1D7874"
  }
];

const fixedEventOrder = [
  "slot_atmosphere",
  "slot_factory",
  "slot_plants",
  "slot_animals",
  "slot_decomposers_land",
  "slot_dead_land",
  "slot_fossil_fuel",
  "slot_carbon_dioxide",
  "slot_algae",
  "slot_fish",
  "slot_decomposers_ocean",
  "slot_dead_ocean"
];

function sanitizeFileName(value) {
  if (!value) return "";
  return value.endsWith(".csv") ? value : `${value}.csv`;
}

function loadCsvCached(cache, path) {
  if (cache.has(path)) {
    return cache.get(path);
  }
  const promise = d3.csv(path, d3.autoType);
  cache.set(path, promise);
  return promise;
}

function loadTimeseriesCsv(fileName) {
  return loadCsvCached(multiTsCache, `multi_ts/${fileName}`);
}

function loadStudentCsv(fileName) {
  return loadCsvCached(studentCache, `student/${fileName}`);
}

function coerceSeriesColumns(rows) {
  if (!rows.length) return [];
  return Object.keys(rows[0]).slice(2, 8);
}

function buildWindowSlice(rows, startIndex) {
  const start = Math.max(0, startIndex);
  const endExclusive = start + WINDOW_LENGTH - 1;
  const slice = rows.slice(start, endExclusive);
  return { start, slice };
}

function getPlottedSeriesValue(columnName, rawValue) {
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric)) return Number.NaN;
  return columnName === "sparsity" ? 1 - numeric : numeric;
}

function ensureGlobalLegend(columns) {
  if (!columns.length || globalSeriesColumns) {
    return;
  }

  globalSeriesColumns = [...columns];
  globalColorScale = d3
    .scaleOrdinal()
    .domain(globalSeriesColumns)
    .range(["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b"]);

  const legendItems = globalLegendEl
    .selectAll(".legend-item")
    .data(globalSeriesColumns)
    .enter()
    .append("div")
    .attr("class", "legend-item");

  legendItems.append("span").attr("class", "legend-swatch").style("background-color", (d) => globalColorScale(d));
  legendItems.append("span").text((d) => d);
}

function centerScrollToMiddle(scrollEl) {
  if (!scrollEl) return;
  const maxScrollLeft = scrollEl.scrollWidth - scrollEl.clientWidth;
  scrollEl.scrollLeft = maxScrollLeft > 0 ? maxScrollLeft * 0.85 : 0;
}

function updateStickyHorizontalScrollbar() {
  const mainScroll = vizScrollEl.node();
  const stickyScroll = stickyXScrollEl.node();
  if (!mainScroll || !stickyScroll) return;

  const contentWidth = Math.max(mainScroll.scrollWidth, mainScroll.clientWidth);
  stickyXScrollInnerEl.style("width", `${contentWidth}px`);
  stickyScroll.scrollLeft = mainScroll.scrollLeft;
}

function initStickyHorizontalScrollbar() {
  const mainScroll = vizScrollEl.node();
  const stickyScroll = stickyXScrollEl.node();
  if (!mainScroll || !stickyScroll) return;

  mainScroll.addEventListener("scroll", () => {
    if (isSyncingHorizontalScroll) return;
    isSyncingHorizontalScroll = true;
    stickyScroll.scrollLeft = mainScroll.scrollLeft;
    isSyncingHorizontalScroll = false;
  });

  stickyScroll.addEventListener("scroll", () => {
    if (isSyncingHorizontalScroll) return;
    isSyncingHorizontalScroll = true;
    mainScroll.scrollLeft = stickyScroll.scrollLeft;
    isSyncingHorizontalScroll = false;
  });

  window.addEventListener("resize", updateStickyHorizontalScrollbar);
  updateStickyHorizontalScrollbar();
}

function renderTimeseriesCard(motifRow, index, rows, columns, startIndex, endIndex) {
  const card = chartsContainer.append("article").attr("class", "chart-card");
  const rowIdx = Number(startIndex);
  const targetRow = Number.isInteger(rowIdx) ? rows[rowIdx] : null;
  const formatValue = (value, digits = 6) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "N/A";
    return Number(numeric.toFixed(digits)).toString();
  };
  const formatPercent = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "N/A";
    return `${Number((numeric * 100).toFixed(2)).toString()}%`;
  };
  const metricValues = DERIVED_METRIC_COLUMNS.map((column) => {
    if (!targetRow) return "N/A";
    const value = Number(targetRow[column]);
    return Number.isFinite(value) ? Number(value.toFixed(6)).toString() : "N/A";
  });

  card.append("h3")
    .attr("class", "chart-title")
    .text(`${index + 1}. ${motifRow.filename}`);
  card.append("p")
    .attr("class", "chart-subtitle")
    .attr("data-role", "derived-range-events")
    .text(`@${startIndex}-${endIndex}`);
  card.append("p")
    .attr("class", "chart-subtitle")
    .text(
      `frequency=${formatValue(motifRow.frequency, 0)}, unique_count=${formatValue(motifRow.unique_count, 0)}, support=${formatPercent(motifRow.support)}`
    );
  card.append("p")
    .attr("class", "chart-subtitle")
    .text(`[${metricValues.join(", ")}]`);

  const meanMetrics = [
    ["max_consecutive_same_source", motifRow.max_consecutive_same_source],
    ["max_consecutive_same_target", motifRow.max_consecutive_same_target],
    ["tracing_count", motifRow.tracing_count],
    ["cycle_count", motifRow.cycle_count],
    ["max_consecutive_same_category", motifRow.max_consecutive_same_category],
    ["sparsity", motifRow.sparsity]
  ];
  const metricsTable = card.append("table").attr("class", "metrics-table");
  const tbody = metricsTable.append("tbody");
  const rowsSelection = tbody.selectAll("tr").data(meanMetrics).enter().append("tr");
  rowsSelection
    .append("td")
    .attr("class", "metrics-label")
    .text(([label]) => label);
  rowsSelection
    .append("td")
    .attr("class", "metrics-value")
    .text(([_label, value]) => formatPercent(value));

  return card;
}

function normalizeStudentRow(row, index) {
  const startTime = Number(row.startTime ?? row.start);
  const endTime = Number(row.endTime ?? row.end);
  const source = String(row.source ?? "").trim();
  const target = String(row.target ?? "").trim();
  return {
    id: row.id ?? `row_${index}`,
    startTime,
    endTime,
    source,
    target,
    valid: Number(row.valid ?? 1),
    duration: row.duration ?? endTime - startTime
  };
}

function extractStudentRowsForWindow(rows, windowIdx) {
  const normalizedRows = rows
    .map((row, index) => normalizeStudentRow(row, index))
    .filter((row) => Number.isFinite(row.startTime) && Number.isFinite(row.endTime) && row.source && row.target);

  const upperStartBound = windowIdx + 60;
  return normalizedRows.filter((row) => row.startTime >= windowIdx && row.startTime < upperStartBound);
}

function extractStudentRowsForRange(rows, windowStart, windowEnd) {
  const normalizedRows = rows
    .map((row, index) => normalizeStudentRow(row, index))
    .filter((row) => Number.isFinite(row.startTime) && Number.isFinite(row.endTime) && row.source && row.target);

  const rangeStart = Number(windowStart);
  const rangeEnd = Number(windowEnd);
  if (!Number.isFinite(rangeStart)) return [];
  if (!Number.isFinite(rangeEnd)) {
    return normalizedRows.filter((row) => row.startTime >= rangeStart);
  }
  return normalizedRows.filter((row) => row.startTime >= rangeStart && row.startTime <= rangeEnd);
}

function parseMatchedMap(matchedValue) {
  if (!matchedValue) return {};
  if (typeof matchedValue === "object") return matchedValue;
  if (typeof matchedValue !== "string") return {};

  try {
    return JSON.parse(matchedValue);
  } catch (_err) {
    try {
      return JSON.parse(matchedValue.replace(/""/g, "\""));
    } catch (_err2) {
      return {};
    }
  }
}

function normalizeMatchedEntries(matchedMap) {
  const normalized = [];
  const entries = Object.entries(matchedMap || {});

  for (let i = 0; i < entries.length; i += 1) {
    const [key, value] = entries[i];

    // New format: { "match_0001": { file_id, window_start, distance, ... } }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const fileName = sanitizeFileName(String(value.file_id ?? value.filename ?? key ?? "").trim());
      const windowIdx = Number(value.window_start);
      const windowEnd = Number(value.window_end);
      const distance = Number(value.distance);
      if (fileName && Number.isFinite(windowIdx)) {
        normalized.push({
          fileName,
          windowIdx,
          windowEnd: Number.isFinite(windowEnd) ? windowEnd : windowIdx + 60,
          distance: Number.isFinite(distance) ? distance : null
        });
      }
      continue;
    }

    // Previous format: { "D2RK": [{ window_start, distance }, ...] } or numeric array
    if (Array.isArray(value)) {
      const fileName = sanitizeFileName(String(key || "").trim());
      if (!fileName) continue;

      value.forEach((item) => {
        const windowIdx = Number(
          typeof item === "object" && item !== null ? item.window_start : item
        );
        const distance =
          typeof item === "object" && item !== null ? Number(item.distance) : null;
        if (Number.isFinite(windowIdx)) {
          normalized.push({
            fileName,
            windowIdx,
            windowEnd: windowIdx + 60,
            distance: Number.isFinite(distance) ? distance : null
          });
        }
      });
    }
  }

  return normalized;
}

async function collectMatchedGroups(matchedValue) {
  const matchedMap = parseMatchedMap(matchedValue);
  const groups = [];
  const normalizedEntries = normalizeMatchedEntries(matchedMap);
  const formatMetricValue = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "N/A";
    return Number(numeric.toFixed(6)).toString();
  };
  for (let i = 0; i < normalizedEntries.length; i += 1) {
    const matchItem = normalizedEntries[i];
    const fileName = matchItem.fileName;
    const windowIdx = Number(matchItem.windowIdx);
    const windowEnd = Number(matchItem.windowEnd);
    const distance = Number(matchItem.distance);
    if (!fileName || !Number.isFinite(windowIdx)) continue;

    try {
      const studentRows = await loadStudentCsv(fileName);
      const sourceRows = await loadTimeseriesCsv(fileName);
      if (Number.isFinite(distance) && distance > matchedDistanceThreshold) {
        continue;
      }
      const extracted = extractStudentRowsForRange(studentRows, windowIdx, windowEnd);
      const targetMetricRow = Number.isInteger(windowIdx) ? sourceRows[windowIdx] : null;
      const metricValues = DERIVED_METRIC_COLUMNS.map((column) => {
        if (!targetMetricRow) return "N/A";
        return formatMetricValue(targetMetricRow[column]);
      });
      const normalizedRows = extracted.map((row, rowIdx) => {
        return {
          ...row,
          id: `${fileName}_${windowIdx}_${windowEnd}_${row.id}_${rowIdx}`,
          valid: Number(row.valid ?? 1)
        };
      });
      if (normalizedRows.length) {
        groups.push({
          fileName,
          windowIdx,
          windowEnd,
          distance: Number.isFinite(distance) ? distance : null,
          metricValues,
          rows: normalizedRows
        });
      }
    } catch (_err) {
      // Ignore missing student files in matched map and continue.
    }
  }

  return groups;
}

function formatDistanceValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "N/A";
  return Number(numeric.toFixed(2)).toString();
}

function updateMatchedDistanceLabel() {
  const maxValue = formatDistanceValue(matchedDistanceSliderEl.attr("max"));
  matchedDistanceValueEl.text(`${formatDistanceValue(matchedDistanceThreshold)} / ${maxValue}`);
}

function updateTopKLabel() {
  const maxValue = Number(topKMotifSliderEl.attr("max")) || topKMotifs;
  topKMotifValueEl.text(`${topKMotifs} / ${maxValue}`);
}

function computeMaxMatchedDistance(motifRows) {
  let maxDistance = 0;
  motifRows.forEach((row) => {
    const matchedMap = parseMatchedMap(row.matched);
    const normalizedEntries = normalizeMatchedEntries(matchedMap);
    normalizedEntries.forEach((entry) => {
      const distance = Number(entry.distance);
      if (Number.isFinite(distance) && distance > maxDistance) {
        maxDistance = distance;
      }
    });
  });
  return maxDistance;
}

function renderStudentCard(motifRow, index, rows, windowIdx) {
  const card = studentChartsContainer.append("article").attr("class", "chart-card");
  const formatMetric = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "N/A";
    return `${Number((numeric * 100).toFixed(2)).toString()}%`;
  };

  card.append("p")
    .attr("class", "chart-subtitle")
    .text(`window_idx=${windowIdx}, # of events=${rows.length}`);

  const metrics = [
    ["max_consecutive_same_source", motifRow.max_consecutive_same_source],
    ["max_consecutive_same_target", motifRow.max_consecutive_same_target],
    ["tracing_count", motifRow.tracing_count],
    ["cycle_count", motifRow.cycle_count],
    ["max_consecutive_same_category", motifRow.max_consecutive_same_category],
    ["sparsity", motifRow.sparsity]
  ];

  const metricsTable = card.append("table").attr("class", "metrics-table");
  const tbody = metricsTable.append("tbody");
  const rowsSelection = tbody.selectAll("tr").data(metrics).enter().append("tr");

  rowsSelection
    .append("td")
    .attr("class", "metrics-label")
    .text(([label]) => label);

  rowsSelection
    .append("td")
    .attr("class", "metrics-value")
    .text(([_label, value]) => formatMetric(value));

  if (!rows.length) {
    card.append("p").attr("class", "error").text("No matching student rows found for this window.");
    return;
  }

  const margin = { top: 10, right: 16, bottom: 34, left: 120 };
  const xDomainStart = windowIdx;
  const xDomainEnd = windowIdx + 60;
  const xDomainRange = xDomainEnd - xDomainStart;
  const chartInnerWidth = Math.max(220, xDomainRange * 5);

  const dynamicItems = Array.from(new Set(rows.flatMap((d) => [d.source, d.target]).filter(Boolean)));
  const extraItems = dynamicItems.filter((item) => !fixedEventOrder.includes(item));
  const categories = extraItems.length
    ? [...categoryConfig, { name: "other", items: extraItems, color: "#BCCCDC" }]
    : categoryConfig;
  const yDomain = categories.flatMap((category) => category.items);

  const itemHeight = 22;
  const categorySpacing = 15;
  const withinCategorySpacing = 2;
  const itemPositions = new Map();
  let currentY = 0;

  categories.forEach((category, categoryIndex) => {
    const categoryItems = category.items.filter((item) => yDomain.includes(item));
    categoryItems.forEach((item, itemIndex) => {
      itemPositions.set(item, {
        y: currentY,
        height: itemHeight,
        category: category.name,
        categoryColor: category.color
      });
      currentY += itemHeight;
      if (itemIndex < categoryItems.length - 1) {
        currentY += withinCategorySpacing;
      }
    });
    if (categoryIndex < categories.length - 1 && categoryItems.length > 0) {
      currentY += categorySpacing;
    }
  });

  const chartInnerHeight = currentY;
  const totalWidth = chartInnerWidth + margin.left + margin.right;
  const totalHeight = chartInnerHeight + margin.top + margin.bottom;
  const chartWrap = card.append("div").attr("class", "student-chart-wrap");
  const svg = chartWrap
    .append("svg")
    .attr("class", "student-svg")
    .attr("width", totalWidth)
    .attr("height", totalHeight)
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  const xScale = d3.scaleLinear().domain([xDomainStart, xDomainEnd]).range([0, chartInnerWidth]);
  const tickStart = Math.ceil(xDomainStart / 5) * 5;
  const tickEnd = Math.floor(xDomainEnd / 5) * 5;
  const xTickValues = tickStart <= tickEnd ? d3.range(tickStart, tickEnd + 1, 5) : [Math.round(xDomainStart), Math.round(xDomainEnd)];
  const yScale = (item) => {
    const pos = itemPositions.get(item);
    return pos ? pos.y : 0;
  };
  yScale.bandwidth = () => itemHeight;

  const categoryGroups = [];
  let currentGroup = null;
  yDomain.forEach((item) => {
    const pos = itemPositions.get(item);
    if (!pos) return;
    if (!currentGroup || currentGroup.category !== pos.category) {
      currentGroup = {
        category: pos.category,
        color: pos.categoryColor,
        startY: pos.y,
        endY: pos.y + pos.height
      };
      categoryGroups.push(currentGroup);
    } else {
      currentGroup.endY = pos.y + pos.height;
    }
  });

  svg.selectAll(".category-background")
    .data(categoryGroups)
    .enter()
    .append("rect")
    .attr("class", "category-background")
    .attr("x", 0)
    .attr("y", (d) => d.startY)
    .attr("width", chartInnerWidth)
    .attr("height", (d) => d.endY - d.startY)
    .attr("fill", (d) => d.color)
    .attr("opacity", 0.3);

  svg.append("g")
    .attr("class", "axis")
    .attr("transform", `translate(0,${chartInnerHeight})`)
    .call(d3.axisBottom(xScale).tickValues(xTickValues).tickFormat(d3.format("d")));

  const yTicks = yDomain.map((item) => ({
    item,
    position: yScale(item) + itemHeight / 2
  }));
  const yAxisGroup = svg.append("g").attr("class", "axis");
  yAxisGroup.selectAll(".tick")
    .data(yTicks)
    .enter()
    .append("g")
    .attr("class", "tick")
    .attr("transform", (d) => `translate(0,${d.position})`)
    .each(function addTick(d) {
      const tick = d3.select(this);
      tick.append("line").attr("x1", 0).attr("x2", -6).attr("stroke", "currentColor");
      tick.append("text")
        .attr("x", -10)
        .attr("dy", "0.32em")
        .attr("text-anchor", "end")
        .text(d.item.replace(/^slot_/, ""));
    });

  svg.append("text")
    .attr("transform", "rotate(-90)")
    .attr("y", 0 - margin.left + 14)
    .attr("x", 0 - chartInnerHeight / 2)
    .attr("dy", "1em")
    .style("text-anchor", "middle")
    .style("font-size", "12px")
    .style("fill", "#486581")
    .text("Events");

  svg.append("text")
    .attr("transform", `translate(${chartInnerWidth / 2}, ${chartInnerHeight + margin.bottom - 8})`)
    .style("text-anchor", "middle")
    .style("font-size", "12px")
    .style("fill", "#486581")
    .text("Time");

  const defs = svg.append("defs");
  rows.forEach((d, i) => {
    const gradientId = `comet-gradient-${index}-${i}`;
    const color = d.valid === 1 ? "green" : "red";
    const gradient = defs.append("linearGradient")
      .attr("id", gradientId)
      .attr("gradientUnits", "userSpaceOnUse")
      .attr("x1", xScale(d.startTime))
      .attr("y1", yScale(d.source) + yScale.bandwidth() / 2)
      .attr("x2", xScale(d.endTime))
      .attr("y2", yScale(d.target) + yScale.bandwidth() / 2);

    gradient.append("stop").attr("offset", "0%").attr("stop-color", color).attr("stop-opacity", 0.4);
    gradient.append("stop").attr("offset", "70%").attr("stop-color", color).attr("stop-opacity", 0.8);
    gradient.append("stop").attr("offset", "100%").attr("stop-color", color).attr("stop-opacity", 1);
  });

  svg.selectAll(".comet-path")
    .data(rows, (d) => `${d.id}_${d.startTime}_${d.endTime}`)
    .enter()
    .append("path")
    .attr("class", "comet-path")
    .attr("fill", "none")
    .attr("stroke", (_d, i) => `url(#comet-gradient-${index}-${i})`)
    .attr("stroke-width", 2)
    .attr("stroke-linecap", "round")
    .attr("d", (d) => {
      const x1 = xScale(d.startTime);
      const y1 = yScale(d.source) + yScale.bandwidth() / 2;
      const x2 = xScale(d.endTime);
      const y2 = yScale(d.target) + yScale.bandwidth() / 2;
      return `M${x1},${y1} L${x2},${y2}`;
    })
    .on("mouseover", function onOver(event, d) {
      d3.select(this).attr("stroke-width", 4);
      tooltip.style("opacity", 1)
        .html(
          `<strong>${d.id}</strong><br/>From: ${d.source} @ ${d.startTime}<br/>To: ${d.target} @ ${d.endTime}<br/>Duration: ${d.duration}`
        )
        .style("left", `${event.clientX + 10}px`)
        .style("top", `${event.clientY - 28}px`);
    })
    .on("mouseout", function onOut() {
      d3.select(this).attr("stroke-width", 2);
      tooltip.style("opacity", 0);
    });

  svg.selectAll(".start-point")
    .data(rows)
    .enter()
    .append("circle")
    .attr("class", "start-point")
    .attr("r", 1)
    .attr("cx", (d) => xScale(d.startTime))
    .attr("cy", (d) => yScale(d.source) + yScale.bandwidth() / 2)
    .attr("fill", (d) => (d.valid === 1 ? "green" : "red"))
    .attr("opacity", 0.8);

  svg.selectAll(".end-point")
    .data(rows)
    .enter()
    .append("circle")
    .attr("class", "end-point")
    .attr("r", 2)
    .attr("cx", (d) => xScale(d.endTime))
    .attr("cy", (d) => yScale(d.target) + yScale.bandwidth() / 2)
    .attr("fill", (d) => (d.valid === 1 ? "green" : "red"))
    .attr("stroke", (d) => (d.valid === 1 ? "darkgreen" : "darkred"))
    .attr("stroke-width", 0.8);

  // Default each card's inner horizontal view to center.
  centerScrollToMiddle(chartWrap.node());
}

function renderMatchedSubChart(container, rows, windowStart, windowEnd) {
  const margin = { top: 10, right: 16, bottom: 34, left: 120 };
  const minStart = Number(windowStart);
  const parsedEnd = Number(windowEnd);
  const xDomainEnd = Number.isFinite(parsedEnd) ? Math.max(minStart, parsedEnd) : minStart + 60;
  const plotRows = rows.filter((d) => Number(d.endTime) <= xDomainEnd);
  const xDomainRange = xDomainEnd - minStart;
  const chartInnerWidth = Math.max(220, xDomainRange * 5);

  const dynamicItems = Array.from(new Set(plotRows.flatMap((d) => [d.source, d.target]).filter(Boolean)));
  const extraItems = dynamicItems.filter((item) => !fixedEventOrder.includes(item));
  const categories = extraItems.length
    ? [...categoryConfig, { name: "other", items: extraItems, color: "#E4E7EB" }]
    : categoryConfig;
  const yDomain = categories.flatMap((category) => category.items);

  const itemHeight = 22;
  const categorySpacing = 15;
  const withinCategorySpacing = 2;
  const itemPositions = new Map();
  let currentY = 0;

  categories.forEach((category, categoryIndex) => {
    const categoryItems = category.items.filter((item) => yDomain.includes(item));
    categoryItems.forEach((item, itemIndex) => {
      itemPositions.set(item, {
        y: currentY,
        height: itemHeight,
        category: category.name,
        categoryColor: category.color
      });
      currentY += itemHeight;
      if (itemIndex < categoryItems.length - 1) {
        currentY += withinCategorySpacing;
      }
    });
    if (categoryIndex < categories.length - 1 && categoryItems.length > 0) {
      currentY += categorySpacing;
    }
  });

  const chartInnerHeight = currentY;
  const totalWidth = chartInnerWidth + margin.left + margin.right;
  const totalHeight = chartInnerHeight + margin.top + margin.bottom;
  const chartWrap = container.append("div").attr("class", "student-chart-wrap");
  const svg = chartWrap
    .append("svg")
    .attr("class", "student-svg")
    .attr("width", totalWidth)
    .attr("height", totalHeight)
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  const xScale = d3.scaleLinear().domain([minStart, xDomainEnd]).range([0, chartInnerWidth]);
  const tickStart = Math.ceil(minStart / 5) * 5;
  const tickEnd = Math.floor(xDomainEnd / 5) * 5;
  const xTickValues = tickStart <= tickEnd ? d3.range(tickStart, tickEnd + 1, 5) : [Math.round(minStart), Math.round(xDomainEnd)];
  const yScale = (item) => {
    const pos = itemPositions.get(item);
    return pos ? pos.y : 0;
  };
  yScale.bandwidth = () => itemHeight;

  const categoryGroups = [];
  let currentGroup = null;
  yDomain.forEach((item) => {
    const pos = itemPositions.get(item);
    if (!pos) return;
    if (!currentGroup || currentGroup.category !== pos.category) {
      currentGroup = {
        category: pos.category,
        color: pos.categoryColor,
        startY: pos.y,
        endY: pos.y + pos.height
      };
      categoryGroups.push(currentGroup);
    } else {
      currentGroup.endY = pos.y + pos.height;
    }
  });

  svg.selectAll(".category-background")
    .data(categoryGroups)
    .enter()
    .append("rect")
    .attr("class", "category-background")
    .attr("x", 0)
    .attr("y", (d) => d.startY)
    .attr("width", chartInnerWidth)
    .attr("height", (d) => d.endY - d.startY)
    .attr("fill", (d) => d.color)
    .attr("opacity", 0.2);

  svg.append("g")
    .attr("class", "axis")
    .attr("transform", `translate(0,${chartInnerHeight})`)
    .call(d3.axisBottom(xScale).tickValues(xTickValues).tickFormat(d3.format("d")));

  const yTicks = yDomain.map((item) => ({
    item,
    position: yScale(item) + itemHeight / 2
  }));
  const yAxisGroup = svg.append("g").attr("class", "axis");
  yAxisGroup.selectAll(".tick")
    .data(yTicks)
    .enter()
    .append("g")
    .attr("class", "tick")
    .attr("transform", (d) => `translate(0,${d.position})`)
    .each(function addTick(d) {
      const tick = d3.select(this);
      tick.append("line").attr("x1", 0).attr("x2", -6).attr("stroke", "currentColor");
      tick.append("text")
        .attr("x", -10)
        .attr("dy", "0.32em")
        .attr("text-anchor", "end")
        .text(d.item.replace(/^slot_/, ""));
    });

  svg.selectAll(".matched-path")
    .data(plotRows)
    .enter()
    .append("path")
    .attr("class", "matched-path")
    .attr("fill", "none")
    .attr("stroke", (d) => (d.valid === 1 ? "green" : "red"))
    .attr("stroke-opacity", 0.5)
    .attr("stroke-width", 1.8)
    .attr("stroke-linecap", "round")
    .attr("d", (d) => {
      const x1 = xScale(d.startTime);
      const y1 = yScale(d.source) + yScale.bandwidth() / 2;
      const x2 = xScale(d.endTime);
      const y2 = yScale(d.target) + yScale.bandwidth() / 2;
      return `M${x1},${y1} L${x2},${y2}`;
    });

  svg.selectAll(".matched-start-point")
    .data(plotRows)
    .enter()
    .append("circle")
    .attr("class", "matched-start-point")
    .attr("r", 1)
    .attr("cx", (d) => xScale(d.startTime))
    .attr("cy", (d) => yScale(d.source) + yScale.bandwidth() / 2)
    .attr("fill", (d) => (d.valid === 1 ? "green" : "red"))
    .attr("opacity", 0.7);

  svg.selectAll(".matched-end-point")
    .data(plotRows)
    .enter()
    .append("circle")
    .attr("class", "matched-end-point")
    .attr("r", 2)
    .attr("cx", (d) => xScale(d.endTime))
    .attr("cy", (d) => yScale(d.target) + yScale.bandwidth() / 2)
    .attr("fill", (d) => (d.valid === 1 ? "green" : "red"))
    .attr("stroke", (d) => (d.valid === 1 ? "darkgreen" : "darkred"))
    .attr("stroke-width", 0.6);

  centerScrollToMiddle(chartWrap.node());
  return plotRows.length;
}

function renderCorrespondingCard(motifRow, index, groups, windowIdx) {
  const card = studentChartsContainer.append("article").attr("class", "chart-card");
 
  if (!groups.length) {
    card.append("p").attr("class", "error").text("No matching rows resolved from `matched` map.");
    return;
  }

  const stack = card.append("div").attr("class", "matched-stack");
  groups.forEach((group) => {
    const rowBlock = stack.append("div").attr("class", "matched-item");
    const distanceLabel = group.distance !== null ? `, distance=${group.distance.toFixed(3)}` : "";
    rowBlock.append("p")
      .attr("class", "chart-subtitle")
      .html(
        `<strong><u>${group.fileName.replace(".csv", "")}</u></strong> @ ${group.windowIdx}-${group.windowEnd} (${group.rows.length} events${distanceLabel})`
      );
    rowBlock
      .append("p")
      .attr("class", "chart-subtitle")
      .text(`[${(group.metricValues || []).join(", ")}]`);
    renderMatchedSubChart(rowBlock, group.rows, group.windowIdx, group.windowEnd);
  });
}

function renderStudentErrorCard(index, fileName, message) {
  const card = studentChartsContainer.append("article").attr("class", "chart-card");
  card.append("h3").attr("class", "chart-title").text(`${index + 1}. ${fileName}`);
  card.append("p").attr("class", "error").text(message);
}

async function run() {
  const runId = ++currentRunId;
  const selectedMotifPath = motifSelectEl.property("value") || MOTIF_CSV_OPTIONS[0];

  chartsContainer.selectAll("*").remove();
  studentChartsContainer.selectAll("*").remove();
  globalLegendEl.selectAll(".legend-item").remove();
  globalSeriesColumns = null;
  globalColorScale = null;

  try {
    const motifRows = await d3.csv(selectedMotifPath, d3.autoType);
    if (runId !== currentRunId) return;

    const motifCount = motifRows.length;
    topKMotifSliderEl.attr("max", Math.max(1, motifCount));
    if (resetSlidersToMaxOnNextRun) {
      topKMotifs = Math.max(1, motifCount);
      topKMotifSliderEl.property("value", topKMotifs);
    } else if (topKMotifs > motifCount) {
      topKMotifs = motifCount;
      topKMotifSliderEl.property("value", topKMotifs);
    }
    if (topKMotifs < 1) {
      topKMotifs = 1;
      topKMotifSliderEl.property("value", topKMotifs);
    }
    updateTopKLabel();

    const maxDistance = computeMaxMatchedDistance(motifRows);
    const sliderMax = maxDistance > 0 ? Number(maxDistance.toFixed(2)) : 10;
    matchedDistanceSliderEl.attr("max", sliderMax);
    if (resetSlidersToMaxOnNextRun) {
      matchedDistanceThreshold = sliderMax;
      matchedDistanceSliderEl.property("value", sliderMax);
    } else if (matchedDistanceThreshold > sliderMax) {
      matchedDistanceThreshold = sliderMax;
      matchedDistanceSliderEl.property("value", sliderMax);
    }
    updateMatchedDistanceLabel();
    resetSlidersToMaxOnNextRun = false;

    const motifRowsToRender = motifRows.slice(0, topKMotifs);
    statusEl.text(`Loaded ${selectedMotifPath} (${motifRowsToRender.length}/${motifRows.length} rows). Rendering chart rows...`);

    for (let i = 0; i < motifRowsToRender.length; i += 1) {
      if (runId !== currentRunId) return;
      const motifRow = motifRowsToRender[i];
      const fileName = sanitizeFileName(String(motifRow.filename || "").trim());
      const windowIdx = Number(motifRow.window_start);
      const parsedWindowEnd = Number(motifRow.window_end);
      const windowEnd = Number.isFinite(parsedWindowEnd) ? parsedWindowEnd : windowIdx + 60;

      if (!fileName || !Number.isInteger(windowIdx)) {
        const card = chartsContainer.append("article").attr("class", "chart-card");
        card.append("h3").attr("class", "chart-title").text(`${i + 1}. Invalid motif row`);
        card.append("p").attr("class", "error").text("Missing filename or window_start.");
        renderStudentErrorCard(i, "Invalid motif row", "Missing filename or window_start.");
        continue;
      }

      let derivedCard = null;
      try {
        const sourceRows = await loadTimeseriesCsv(fileName);
        derivedCard = renderTimeseriesCard(
          motifRow,
          i,
          sourceRows,
          DERIVED_METRIC_COLUMNS,
          windowIdx,
          windowEnd
        );
      } catch (err) {
        const card = chartsContainer.append("article").attr("class", "chart-card");
        card.append("h3").attr("class", "chart-title").text(`${i + 1}. ${fileName}`);
        card.append("p").attr("class", "error").text(`Failed to load file: multi_ts/${fileName}`);
        console.error(err);
      }

      if (derivedCard) {
        try {
          const motifStudentRows = await loadStudentCsv(fileName);
          const extractedMotifRows = extractStudentRowsForRange(motifStudentRows, windowIdx, windowEnd);
          if (!extractedMotifRows.length) {
            derivedCard
              .append("p")
              .attr("class", "error")
              .text("No student rows found for this motif range.");
          } else {
            const plottedEventCount = renderMatchedSubChart(derivedCard, extractedMotifRows, windowIdx, windowEnd);
            derivedCard
              .select('[data-role="derived-range-events"]')
              .text(`@${windowIdx}-${windowEnd}, ${plottedEventCount} events`);
          }
        } catch (err) {
          derivedCard
            .append("p")
            .attr("class", "error")
            .text(`Failed to load file: student/${fileName}`);
          console.error(err);
        }
      }

      try {
        const matchedGroups = await collectMatchedGroups(motifRow.matched);
        renderCorrespondingCard(motifRow, i, matchedGroups, windowIdx);
      } catch (err) {
        renderStudentErrorCard(i, fileName, "Failed to parse or render matched mapping.");
        console.error(err);
      }
    }

    statusEl.text(`Render complete: ${selectedMotifPath}`);
    updateStickyHorizontalScrollbar();
  } catch (err) {
    statusEl.attr("class", "status error").text(`Failed to load ${selectedMotifPath}`);
    updateStickyHorizontalScrollbar();
    console.error(err);
  }
}

function initMotifSelector() {
  motifSelectEl.property("value", MOTIF_CSV_OPTIONS[0]);
  motifSelectEl.on("change", () => {
    resetSlidersToMaxOnNextRun = true;
    statusEl.attr("class", "status").text("Loading selected motif file...");
    run();
  });
}

function initMatchedDistanceSlider() {
  updateMatchedDistanceLabel();
  matchedDistanceSliderEl.on("input", () => {
    matchedDistanceThreshold = Number(matchedDistanceSliderEl.property("value"));
    updateMatchedDistanceLabel();
  });
  matchedDistanceSliderEl.on("change", () => {
    matchedDistanceThreshold = Number(matchedDistanceSliderEl.property("value"));
    updateMatchedDistanceLabel();
    statusEl.attr("class", "status").text("Applying matched distance filter...");
    run();
  });
}

function initTopKMotifSlider() {
  updateTopKLabel();
  topKMotifSliderEl.on("input", () => {
    topKMotifs = Number(topKMotifSliderEl.property("value"));
    updateTopKLabel();
  });
  topKMotifSliderEl.on("change", () => {
    topKMotifs = Number(topKMotifSliderEl.property("value"));
    updateTopKLabel();
    statusEl.attr("class", "status").text("Applying top-k motif filter...");
    run();
  });
}

initMotifSelector();
initMatchedDistanceSlider();
initTopKMotifSlider();
initStickyHorizontalScrollbar();
run();
