const WINDOW_LENGTH = 31; // window_idx through window_idx + 30
const CHART_WIDTH = 300;
const CHART_HEIGHT = 100;
const MARGIN = { top: 10, right: 12, bottom: 26, left: 38 };

const chartsContainer = d3.select("#charts");
const studentChartsContainer = d3.select("#student-charts");
const matchedChartsContainer = d3.select("#matched-charts");
const statusEl = d3.select("#status");
const globalLegendEl = d3.select("#global-legend");
const tooltip = d3.select("#tooltip");

const multiTsCache = new Map();
const studentCache = new Map();
let globalSeriesColumns = null;
let globalColorScale = null;

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
  return Object.keys(rows[0]).slice(0, 5);
}

function buildWindowSlice(rows, startIndex) {
  const start = Math.max(0, startIndex);
  const endExclusive = start + WINDOW_LENGTH -1;
  const slice = rows.slice(start, endExclusive);
  return { start, slice };
}

function ensureGlobalLegend(columns) {
  if (!columns.length || globalSeriesColumns) {
    return;
  }

  globalSeriesColumns = [...columns];
  globalColorScale = d3
    .scaleOrdinal()
    .domain(globalSeriesColumns)
    .range(["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd"]);

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

function renderTimeseriesCard(motifRow, index, rows, columns, startIndex) {
  const card = chartsContainer.append("article").attr("class", "chart-card");
  card.append("h3")
    .attr("class", "chart-title")
    .text(`${index + 1}. ${motifRow.filename}`);
  card.append("p")
    .attr("class", "chart-subtitle")
    .text(`window_idx=${startIndex}, points=${rows.length}`);

  if (!rows.length || !columns.length) {
    card.append("p").attr("class", "error").text("No data available for this window.");
    return;
  }

  const svg = card
    .append("svg")
    .attr("class", "chart-svg")
    .attr("viewBox", `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`);

  const plotWidth = CHART_WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;
  const g = svg.append("g").attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

  const series = columns.map((name) => ({
    name,
    values: rows.map((row, i) => ({
      x: startIndex + i,
      y: Number(row[name])
    }))
  }));

  const yValues = series.flatMap((s) => s.values.map((d) => d.y)).filter((v) => Number.isFinite(v));
  const yExtent = d3.extent(yValues);
  const yMin = yExtent[0] ?? 0;
  const yMax = yExtent[1] ?? 1;
  const yPad = yMin === yMax ? 1 : (yMax - yMin) * 0.1;

  const x = d3
    .scaleLinear()
    .domain(d3.extent(rows, (_, i) => startIndex + i))
    .range([0, plotWidth]);

  const y = d3
    .scaleLinear()
    .domain([yMin - yPad, yMax + yPad])
    .range([plotHeight, 0]);

  g.append("g")
    .attr("class", "axis")
    .attr("transform", `translate(0,${plotHeight})`)
    .call(d3.axisBottom(x).ticks(5).tickFormat(d3.format("d")));

  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4));

  const line = d3
    .line()
    .defined((d) => Number.isFinite(d.y))
    .x((d) => x(d.x))
    .y((d) => y(d.y));

  g.selectAll(".line")
    .data(series)
    .enter()
    .append("path")
    .attr("class", "line")
    .attr("stroke", (d) => globalColorScale(d.name))
    .attr("d", (d) => line(d.values));
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

  const upperStartBound = windowIdx + WINDOW_LENGTH*2;
  const extracted = [];

  let started = false;
  for (let i = 0; i < normalizedRows.length; i += 1) {
    const row = normalizedRows[i];

    if (!started) {
      if (row.startTime > windowIdx) {
        started = true;
      } else {
        continue;
      }
    }

    if (row.startTime > upperStartBound) {
      break;
    }

    extracted.push(row);
  }

  return extracted;
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

async function collectMatchedGroups(matchedValue) {
  const matchedMap = parseMatchedMap(matchedValue);
  const groups = [];
  const entries = Object.entries(matchedMap);

  for (let fileIdx = 0; fileIdx < entries.length; fileIdx += 1) {
    const [baseName, indices] = entries[fileIdx];
    const fileName = sanitizeFileName(String(baseName || "").trim());
    if (!fileName || !Array.isArray(indices)) {
      continue;
    }

    try {
      const studentRows = await loadStudentCsv(fileName);
      for (let idxPos = 0; idxPos < indices.length; idxPos += 1) {
        const windowIdx = Number(indices[idxPos]);
        if (!Number.isFinite(windowIdx)) {
          continue;
        }
        const extracted = extractStudentRowsForWindow(studentRows, windowIdx);
        const normalizedRows = extracted.map((row, rowIdx) => {
          return {
            ...row,
            id: `${fileName}_${windowIdx}_${row.id}_${rowIdx}`,
            valid: 1
          };
        });
        if (normalizedRows.length) {
          groups.push({
            fileName,
            windowIdx,
            rows: normalizedRows
          });
        }
      }
    } catch (_err) {
      // Ignore missing student files in matched map and continue.
    }
  }

  return groups;
}

function renderStudentCard(motifRow, index, rows, windowIdx) {
  const card = studentChartsContainer.append("article").attr("class", "chart-card");
  card.append("h3")
    .attr("class", "chart-title")
    .text(`${index + 1}. ${motifRow.filename}`);
  card.append("p")
    .attr("class", "chart-subtitle")
    .text(`window_idx=${windowIdx}, events=${rows.length}`);

  if (!rows.length) {
    card.append("p").attr("class", "error").text("No matching student rows found for this window.");
    return;
  }

  const margin = { top: 10, right: 16, bottom: 34, left: 120 };
  const minStart = d3.min(rows, (d) => d.startTime);
  const maxEnd = d3.max(rows, (d) => d.endTime);
  const xDomainRange = Math.max(60, maxEnd - minStart);
  const xDomainEnd = minStart + xDomainRange;
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

  const xScale = d3.scaleLinear().domain([minStart, xDomainEnd]).range([0, chartInnerWidth]);
  const tickStart = Math.ceil(minStart / 5) * 5;
  const tickEnd = Math.floor(xDomainEnd / 5) * 5;
  const xTickValues = tickStart <= tickEnd ? d3.range(tickStart, tickEnd + 1, 5) : [Math.round(minStart), Math.round(maxEnd)];
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

function renderMatchedSubChart(container, rows) {
  const margin = { top: 10, right: 16, bottom: 34, left: 120 };
  const minStart = d3.min(rows, (d) => d.startTime);
  const maxEnd = d3.max(rows, (d) => d.endTime);
  const xDomainRange = Math.max(60, maxEnd - minStart);
  const xDomainEnd = minStart + xDomainRange;
  const chartInnerWidth = Math.max(220, xDomainRange * 5);

  const dynamicItems = Array.from(new Set(rows.flatMap((d) => [d.source, d.target]).filter(Boolean)));
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
  const xTickValues = tickStart <= tickEnd ? d3.range(tickStart, tickEnd + 1, 5) : [Math.round(minStart), Math.round(maxEnd)];
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

  const matchedColor = "#808080";
  svg.selectAll(".matched-path")
    .data(rows)
    .enter()
    .append("path")
    .attr("class", "matched-path")
    .attr("fill", "none")
    .attr("stroke", matchedColor)
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
    .data(rows)
    .enter()
    .append("circle")
    .attr("class", "matched-start-point")
    .attr("r", 1)
    .attr("cx", (d) => xScale(d.startTime))
    .attr("cy", (d) => yScale(d.source) + yScale.bandwidth() / 2)
    .attr("fill", matchedColor)
    .attr("opacity", 0.7);

  svg.selectAll(".matched-end-point")
    .data(rows)
    .enter()
    .append("circle")
    .attr("class", "matched-end-point")
    .attr("r", 2)
    .attr("cx", (d) => xScale(d.endTime))
    .attr("cy", (d) => yScale(d.target) + yScale.bandwidth() / 2)
    .attr("fill", matchedColor)
    .attr("stroke", "#666666")
    .attr("stroke-width", 0.6);

  centerScrollToMiddle(chartWrap.node());
}

function renderMatchedCard(motifRow, index, groups, windowIdx) {
  const card = matchedChartsContainer.append("article").attr("class", "chart-card");
  card.append("h3")
    .attr("class", "chart-title")
    .text(`${index + 1}. ${motifRow.filename}`);
  card.append("p")
    .attr("class", "chart-subtitle")
    .text(`window_idx=${windowIdx}, matched charts=${groups.length}`);

  if (!groups.length) {
    card.append("p").attr("class", "error").text("No matching rows resolved from `matched` map.");
    return;
  }

  const stack = card.append("div").attr("class", "matched-stack");
  groups.forEach((group) => {
    const rowBlock = stack.append("div").attr("class", "matched-item");
    rowBlock.append("p")
      .attr("class", "chart-subtitle")
      .text(`${group.fileName.replace(".csv", "")} @ ${group.windowIdx} (${group.rows.length} events)`);
    renderMatchedSubChart(rowBlock, group.rows);
  });
}

function renderStudentErrorCard(index, fileName, message) {
  const card = studentChartsContainer.append("article").attr("class", "chart-card");
  card.append("h3").attr("class", "chart-title").text(`${index + 1}. ${fileName}`);
  card.append("p").attr("class", "error").text(message);
}

function renderMatchedErrorCard(index, fileName, message) {
  const card = matchedChartsContainer.append("article").attr("class", "chart-card");
  card.append("h3").attr("class", "chart-title").text(`${index + 1}. ${fileName}`);
  card.append("p").attr("class", "error").text(message);
}

async function run() {
  try {
    const motifRows = await d3.csv("motif.csv", d3.autoType);
    statusEl.text(`Loaded motif.csv (${motifRows.length} rows). Rendering chart rows...`);

    for (let i = 0; i < motifRows.length; i += 1) {
      const motifRow = motifRows[i];
      const fileName = sanitizeFileName(String(motifRow.filename || "").trim());
      const windowIdx = Number(motifRow.window_idx);

      if (!fileName || !Number.isInteger(windowIdx)) {
        const card = chartsContainer.append("article").attr("class", "chart-card");
        card.append("h3").attr("class", "chart-title").text(`${i + 1}. Invalid motif row`);
        card.append("p").attr("class", "error").text("Missing filename or window_idx.");
        renderStudentErrorCard(i, "Invalid motif row", "Missing filename or window_idx.");
        renderMatchedErrorCard(i, "Invalid motif row", "Missing filename or window_idx.");
        continue;
      }

      try {
        const sourceRows = await loadTimeseriesCsv(fileName);
        const columns = coerceSeriesColumns(sourceRows);
        ensureGlobalLegend(columns);
        const { slice } = buildWindowSlice(sourceRows, windowIdx);
        renderTimeseriesCard(motifRow, i, slice, columns, windowIdx);
      } catch (err) {
        const card = chartsContainer.append("article").attr("class", "chart-card");
        card.append("h3").attr("class", "chart-title").text(`${i + 1}. ${fileName}`);
        card.append("p").attr("class", "error").text(`Failed to load file: multi_ts/${fileName}`);
        console.error(err);
      }

      try {
        const studentRows = await loadStudentCsv(fileName);
        const extracted = extractStudentRowsForWindow(studentRows, windowIdx);
        renderStudentCard(motifRow, i, extracted, windowIdx);
      } catch (err) {
        renderStudentErrorCard(i, fileName, `Failed to load file: student/${fileName}`);
        console.error(err);
      }

      try {
        const matchedGroups = await collectMatchedGroups(motifRow.matched);
        renderMatchedCard(motifRow, i, matchedGroups, windowIdx);
      } catch (err) {
        renderMatchedErrorCard(i, fileName, "Failed to parse or render matched mapping.");
        console.error(err);
      }
    }

    statusEl.text("Render complete.");
  } catch (err) {
    statusEl.attr("class", "status error").text("Failed to load motif.csv");
    console.error(err);
  }
}

run();
