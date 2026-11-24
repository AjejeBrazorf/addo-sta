/* Lanes: the map style system.
   Ring = family (road blue, rail red, cable amber, tram split), fill = operator (white ANM, gray EAV, red FS).
   Geometry lives here, colours live in styles.css as custom properties so both themes share one painter. */
(function () {
  const KINDS = ["bus", "ebus", "fil", "tram", "metro", "fs", "eav", "funi"];

  const NAME = {
    bus: "Bus ANM",
    ebus: "Bus EAV",
    fil: "Filobus ANM",
    tram: "Tram ANM",
    metro: "Metro L1/L6",
    fs: "FS Linea 2",
    eav: "Treno EAV",
    funi: "Funicolare",
  };

  const STOP = {
    bus: { shape: "circle", w: 9, h: 9, rings: [1.5] },
    ebus: { shape: "circle", w: 9, h: 9, rings: [1.5] },
    fil: { shape: "squircle", w: 17, h: 17, rings: [2], glyph: "trolley" },
    tram: { shape: "circle", w: 18, h: 18, rings: [2.5], split: true, glyph: "tram" },
    metro: { shape: "circle", w: 22, h: 22, rings: [3.5], glyph: "M" },
    fs: { shape: "circle", w: 22, h: 22, rings: [3.5], glyph: "M" },
    eav: { shape: "squircle", w: 22, h: 22, rings: [3], glyph: "train" },
    funi: { shape: "circle", w: 22, h: 22, rings: [2.5], glyph: "cable" },
  };

  const VEH = {
    bus: { shape: "circle", w: 28, h: 28, rings: [3] },
    ebus: { shape: "circle", w: 28, h: 28, rings: [3] },
    fil: { shape: "squircle", w: 26, h: 26, rings: [3] },
    tram: { shape: "pill", w: 38, h: 24, rings: [3], split: true },
    metro: { shape: "rect", w: 38, h: 24, rings: [3] },
    fs: { shape: "rect", w: 38, h: 24, rings: [1.5, 1.5] },
    eav: { shape: "rect", w: 38, h: 24, rings: [3] },
    funi: { shape: "trap", w: 32, h: 26, rings: [3] },
  };

  const PATTERN = { bus: "solid", ebus: "solid", fil: "dash", tram: "dot", metro: "ties", fs: "ties", eav: "ties", funi: "long" };

  const STOP_SCALE = [[16, 1.15], [15, 1], [14, 0.9], [0, 0.75]];

  function stopScale(zoom) {
    return STOP_SCALE.find(([min]) => zoom >= min)[1];
  }

  function operatorKind(operator) {
    return { fs: "fs", "eav-rail": "eav", "eav-bus": "ebus" }[operator] || "bus";
  }

  function stopKind(k, operator) {
    if (k === 3) return operator === "eav-bus" ? "ebus" : "bus";
    if (k === 11) return "fil";
    if (k === 0) return "tram";
    if (k === 1) return operator === "fs" ? "fs" : "metro";
    if (k === 2) return "eav";
    if (k === 7) return "funi";
    return operatorKind(operator);
  }

  function routeKind(typeLabel, operator) {
    if (typeLabel === "Filobus") return "fil";
    if (typeLabel === "Tram") return "tram";
    if (typeLabel === "Funicolare") return "funi";
    if (typeLabel === "Treno") return "eav";
    if (typeLabel === "Metro") return operator === "fs" ? "fs" : "metro";
    return operator === "eav-bus" ? "ebus" : "bus";
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function num(value) {
    return Number(value.toFixed(3));
  }

  function shapeEl(shape, w, h, attrs) {
    if (w <= 0 || h <= 0) return "";
    if (shape === "circle") return `<ellipse rx="${num(w / 2)}" ry="${num(h / 2)}" ${attrs}/>`;
    const rect = (rx) => `<rect x="${num(-w / 2)}" y="${num(-h / 2)}" width="${num(w)}" height="${num(h)}" rx="${num(rx)}" ${attrs}/>`;
    if (shape === "square") return rect(1.5);
    if (shape === "squircle") return rect(Math.min(w, h) * 0.32);
    if (shape === "pill") return rect(h / 2);
    if (shape === "rect") return rect(Math.min(6, h / 3));
    if (shape === "diamond") return `<polygon points="0,${num(-h / 2)} ${num(w / 2)},0 0,${num(h / 2)} ${num(-w / 2)},0" ${attrs}/>`;
    if (shape === "tri") return `<polygon points="0,${num((-2 * h) / 3)} ${num(w / 2)},${num(h / 3)} ${num(-w / 2)},${num(h / 3)}" ${attrs}/>`;
    if (shape === "trap") return `<polygon points="${num(-w * 0.3)},${num(-h / 2)} ${num(w * 0.3)},${num(-h / 2)} ${num(w / 2)},${num(h / 2)} ${num(-w / 2)},${num(h / 2)}" ${attrs}/>`;
    return "";
  }

  function inset(shape, w, h, d) {
    if (shape === "diamond") return [w - 2 * 1.414 * d, h - 2 * 1.414 * d];
    if (shape === "tri") {
      const s = (2 * h) / 3;
      const s2 = s - 2 * d;
      return [w * (s2 / s), 1.5 * s2];
    }
    return [w - 2 * d, h - 2 * d];
  }

  function bounds(shape, w, h) {
    if (shape === "tri") return { x0: -w / 2, x1: w / 2, y0: (-2 * h) / 3, y1: h / 3 };
    return { x0: -w / 2, x1: w / 2, y0: -h / 2, y1: h / 2 };
  }

  /* Rings go outermost first, then the fill. The first layer carries the hairline key as a stroke
     painted underneath, so the key colour and width follow the theme tokens. */
  function layers(prefix, kind, g, fillVar) {
    const base = `--${prefix}-${kind}`;
    let w = g.w;
    let h = g.h;
    let lay = "";
    g.rings.forEach((ring, i) => {
      const key = i === 0
        ? `;stroke:var(--${prefix}-key);stroke-width:calc(var(--${prefix}-key-w) * 2);paint-order:stroke;stroke-linejoin:round`
        : "";
      lay += shapeEl(g.shape, w, h, `style="fill:var(${base}-${i === 0 ? "ring" : "ring2"})${key}"`);
      if (i === 0 && g.split) {
        lay += `<g clip-path="url(#lanes-split)">${shapeEl(g.shape, w, h, `style="fill:var(${base}-ring-b)"`)}</g>`;
      }
      [w, h] = inset(g.shape, w, h, ring);
    });
    lay += shapeEl(g.shape, w, h, `style="fill:var(${fillVar})"`);
    const ring = g.rings[0];
    const hollow = shapeEl(g.shape, g.w - ring, g.h - ring, `style="fill:none;stroke:var(${base}-ring);stroke-width:${ring}"`);
    return { lay, hollow };
  }

  function glyphEl(kind, g) {
    if (!g.glyph) return "";
    const color = `var(--stop-${kind}-glyph)`;
    if (g.glyph === "tram") {
      // tram front with pantograph
      const fill = `var(--stop-${kind}-fill)`;
      return `<g class="gl" style="fill:${color}"><path d="M-2.2 -6.4H2.2M0 -6.4L-1.3 -5.3L0 -4.3" style="fill:none;stroke:${color};stroke-width:1;stroke-linecap:round;stroke-linejoin:round"/><rect x="-3.9" y="-4.3" width="7.8" height="8.6" rx="1.8"/><rect x="-2.7" y="-3.1" width="5.4" height="2.8" rx="0.5" style="fill:${fill}"/><circle cx="-1.9" cy="2" r="0.7" style="fill:${fill}"/><circle cx="1.9" cy="2" r="0.7" style="fill:${fill}"/></g>`;
    }
    if (g.glyph === "trolley") {
      // trolleybus: body with the two current-collector poles
      const fill = `var(--stop-${kind}-fill)`;
      return `<g class="gl" style="fill:${color}"><path d="M-1.2 -2.2L-3.6 -5.6M1.4 -2.2L-1 -5.6" style="fill:none;stroke:${color};stroke-width:0.9;stroke-linecap:round"/><rect x="-4.3" y="-2.4" width="8.6" height="6.4" rx="1.4"/><rect x="-3.1" y="-1.3" width="6.2" height="2.3" rx="0.4" style="fill:${fill}"/></g>`;
    }
    if (g.glyph === "train") {
      // train front: body, windscreen, lamps, rails
      const fill = `var(--stop-${kind}-fill)`;
      return `<g class="gl" style="fill:${color}"><rect x="-4.6" y="-6" width="9.2" height="9" rx="2.4"/><rect x="-3.2" y="-4.6" width="6.4" height="3" rx="0.6" style="fill:${fill}"/><circle cx="-2.4" cy="0.8" r="0.9" style="fill:${fill}"/><circle cx="2.4" cy="0.8" r="0.9" style="fill:${fill}"/><path d="M-3 4.2L-4.6 6.6M3 4.2L4.6 6.6" style="fill:none;stroke:${color};stroke-width:1.2;stroke-linecap:round"/></g>`;
    }
    if (g.glyph === "cable") {
      // aerial-tramway pictogram: sloped cable, hanger, cabin with window
      return `<g class="gl" style="stroke:${color};stroke-width:1.3;stroke-linecap:round;fill:none"><path d="M-7 -5.2L7 -2.2M0 -3.7V-1"/><rect x="-3.8" y="-1" width="7.6" height="6.2" rx="1.2" style="fill:${color};stroke:none"/><path d="M-2.2 0.6H2.2" style="stroke:var(--stop-funi-fill);stroke-width:1.6"/></g>`;
    }
    const long = g.glyph.length > 1;
    return `<text class="gl" x="0" y="${long ? 2.6 : 3.4}" text-anchor="middle" style="fill:${color};font-size:${long ? 8.2 : 11.5}px">${g.glyph}</text>`;
  }

  /* Line-number badges in the top-right corner; the badge colour names the operator (ANM / FS / EAV).
     One digit is a circle, longer numbers stretch into a pill. */
  const BADGE_R = 5.2;

  function badgeBoxes(g, lines) {
    let x = g.w / 2 - 2 - BADGE_R;
    const cy = -g.h / 2 + 2;
    return lines.map((line) => {
      const w = Math.max(2 * BADGE_R, line.length * 4.4 + 4);
      const box = { line, x, w, cy };
      x += w - 1;
      return box;
    });
  }

  /* Line labels come from GTFS feeds. */
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  function badgesEl(kind, g, lines) {
    return `<g class="bd">${badgeBoxes(g, lines).map(({ line, x, w, cy }) => {
      const long = line.length > 1;
      const rect = (d, attrs) => `<rect x="${num(x + d)}" y="${num(cy - BADGE_R + d)}" width="${num(w - 2 * d)}" height="${num(2 * (BADGE_R - d))}" rx="${num(BADGE_R - d)}" ${attrs}/>`;
      return rect(0, `style="fill:var(--badge-${kind}-bg);stroke:var(--stop-key);stroke-width:1.2;paint-order:stroke"`)
        + rect(0.45, `style="fill:none;stroke:var(--badge-${kind}-line);stroke-width:0.9"`)
        + `<text class="gl" x="${num(x + w / 2)}" y="${num(cy + (long ? 2.1 : 2.5))}" text-anchor="middle" style="fill:var(--badge-${kind}-ink);font-size:${long ? 6 : 7}px">${escapeHtml(line)}</text>`;
    }).join("")}</g>`;
  }

  function withBadges(box, g, lines) {
    if (!lines.length) return box;
    const boxes = badgeBoxes(g, lines);
    const last = boxes[boxes.length - 1];
    return {
      x0: box.x0,
      x1: Math.max(box.x1, last.x + last.w + 1),
      y0: Math.min(box.y0, boxes[0].cy - BADGE_R - 1),
      y1: box.y1,
    };
  }

  /* Street stops (bus, filobus, tram) carry their line badges only at close zoom, on a separate
     badge-only marker; long lists collapse to the first three plus "+N". */
  const BADGED = new Set(["metro", "fs", "eav", "funi"]);

  function badgeIcon(kind, lines) {
    const shown = lines.length > 4 ? [...lines.slice(0, 3), `+${lines.length - 3}`] : lines;
    const g = STOP[kind];
    const boxes = badgeBoxes(g, shown);
    const last = boxes[boxes.length - 1];
    const box = { x0: boxes[0].x - 1, x1: last.x + last.w + 1, y0: boxes[0].cy - BADGE_R - 1, y1: boxes[0].cy + BADGE_R + 1 };
    return L.divIcon({ className: `sm bdg k-${kind}`, html: `${svgBox(box, 1)}${badgesEl(kind, g, shown)}</svg>`, iconSize: [0, 0] });
  }

  function svgBox(box, pad, extra = "") {
    const x = num(box.x0 - pad);
    const y = num(box.y0 - pad);
    const w = num(box.x1 - box.x0 + 2 * pad);
    const h = num(box.y1 - box.y0 + 2 * pad);
    return `<svg class="sg" viewBox="${x} ${y} ${w} ${h}" style="left:calc(${x}px * var(--sc));top:calc(${y}px * var(--sc));width:calc(${w}px * var(--sc));height:calc(${h}px * var(--sc))" aria-hidden="true" focusable="false">${extra}`;
  }

  function stopSvg(kind, selected = false, lines = []) {
    const g = STOP[kind];
    const { lay, hollow } = layers("stop", kind, g, `--stop-${kind}-fill`);
    const body = `<g class="lay">${lay}</g><g class="hol">${hollow}</g>${glyphEl(kind, g)}${badgesEl(kind, g, lines)}`;
    const box = withBadges(bounds(g.shape, g.w, g.h), g, lines);
    if (!selected) return `${svgBox(box, 2)}${body}</svg>`;
    const big = Math.max(g.w, g.h) / 2;
    const scale = 1.35;
    const r = big + 7;
    const outer = { x0: Math.min(-r, box.x0), x1: Math.max(r, box.x1), y0: Math.min(-r, box.y0), y1: Math.max(r, box.y1) };
    const halo = `<circle r="${num(big + 6)}" style="fill:var(--stop-${kind}-ring);fill-opacity:var(--sel-halo-alpha)"/><circle r="${num(big + 2.2)}" style="fill:none;stroke:var(--sel-ring);stroke-width:2.4"/>`;
    const scaled = { x0: outer.x0 * scale, x1: outer.x1 * scale, y0: outer.y0 * scale, y1: outer.y1 * scale };
    return `${svgBox(scaled, 0)}<g transform="scale(${scale})">${halo}${body}</g></svg>`;
  }

  function vehSvg(kind) {
    const g = VEH[kind];
    const { lay, hollow } = layers("veh", kind, g, `--veh-${kind}-bg`);
    const halo = `<g class="halo">${shapeEl(g.shape, g.w + 14, g.h + 14, `style="fill:var(--veh-${kind}-ring);fill-opacity:var(--sel-halo-alpha)"`)}${shapeEl(g.shape, g.w + 7, g.h + 7, 'style="fill:none;stroke:var(--sel-ring);stroke-width:2.4"')}</g>`;
    return `${svgBox(bounds(g.shape, g.w, g.h), 2)}${halo}<g class="lay">${lay}</g><g class="hol">${hollow}</g></svg>`;
  }

  function lineSvg(kind, length = 40) {
    const half = length / 2;
    const d = `M${-half} 0H${half}`;
    const pat = PATTERN[kind];
    const stroke = (v, w, extra = "") => `<path d="${d}" style="fill:none;stroke:var(${v});stroke-width:${w}${extra}"/>`;
    let svg = stroke(`--line-${kind}-casing`, 10, ";stroke-linecap:round") + stroke(`--line-${kind}-core`, 6, ";stroke-linecap:round");
    if (pat === "dash") svg += stroke(`--line-${kind}-mark`, 1.8, ";stroke-dasharray:7 6");
    if (pat === "dot") svg += stroke(`--line-${kind}-mark`, 2.2, ";stroke-linecap:round;stroke-dasharray:0.1 5.5");
    if (pat === "ties") svg += stroke(`--line-${kind}-mark`, 6, ";stroke-dasharray:1.8 7");
    if (pat === "long") svg += stroke(`--line-${kind}-casing`, 6, ";stroke-dasharray:12 8");
    return `<svg viewBox="${-half - 6} -7 ${length + 12} 14" width="${length + 12}" height="14" aria-hidden="true" focusable="false">${svg}</svg>`;
  }

  const iconCache = new Map();

  function stopIcon(kind, state = "normal", lines = []) {
    lines = BADGED.has(kind) ? (lines || []).slice(0, 3) : [];
    const key = `${kind}|${state}|${lines.join(",")}`;
    if (!iconCache.has(key)) {
      iconCache.set(key, L.divIcon({
        className: `sm k-${kind}${state === "selected" ? " sel" : ""}`,
        html: stopSvg(kind, state === "selected", lines),
        iconSize: [0, 0],
      }));
    }
    return iconCache.get(key);
  }

  function vehHtml(kind, label) {
    return `<i class="cone" aria-hidden="true"></i><div class="veh" data-k="${kind}">${vehSvg(kind)}<b>${label}</b></div>`;
  }

  function circleStyle(kind, scale = 1) {
    const g = STOP[kind];
    const ring = g.rings[0] * scale;
    return {
      radius: (g.w * scale) / 2 - ring / 2,
      weight: ring,
      color: cssVar(`--stop-${kind}-ring`),
      fillColor: cssVar(`--stop-${kind}-fill`),
      fillOpacity: 1,
    };
  }

  function lineStyle(kind) {
    return {
      core: cssVar(`--line-${kind}-core`),
      casing: cssVar(`--line-${kind}-casing`),
      mark: cssVar(`--line-${kind}-mark`),
      pattern: PATTERN[kind],
    };
  }

  function cell(inner, cls = "") {
    return `<span class="lg-cell ${cls}">${inner}</span>`;
  }

  function legendHtml() {
    const sample = { metro: ["1"], fs: ["2"], eav: ["1", "4"], funi: ["1"] };
    const stopCell = (kind, state = "") => cell(`<span class="lg-sm sm${state}" data-k="${kind}">${stopSvg(kind, state === " sel", state ? [] : sample[kind])}</span>`);
    const vehCell = (kind, label, state = "") => cell(`<span class="veh-wrap lg-wrap k-${kind}${state}"><div class="veh" data-k="${kind}">${vehSvg(kind)}<b>${label}</b></div></span>`, "wide");
    const labels = { bus: "116", ebus: "108", fil: "204", tram: "421", metro: "L1", fs: "L2", eav: "9", funi: "F1" };
    const rows = KINDS.map((kind) => `<li><span class="lg-name">${NAME[kind]}</span>${stopCell(kind)}${vehCell(kind, labels[kind])}${cell(lineSvg(kind, 30), "line")}</li>`).join("");
    return `<div class="legend-head"><span></span><span>Fermata</span><span>Mezzo</span><span>Percorso</span></div><ul class="legend-rows">${rows}</ul>`
      + `<ul class="legend-states"><li>${stopCell("bus", " sel")}<span>fermata scelta</span></li>`
      + `<li>${vehCell("bus", "116", " picked")}<span>mezzo scelto</span></li>`
      + `<li>${vehCell("bus", "116", " other-dir")}<span>altra direzione</span></li></ul>`;
  }

  function mountDefs() {
    if (document.getElementById("lanes-defs")) return;
    const holder = document.createElement("div");
    holder.id = "lanes-defs";
    holder.setAttribute("aria-hidden", "true");
    holder.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    holder.innerHTML = '<svg width="0" height="0" focusable="false"><defs><clipPath id="lanes-split"><polygon points="-60,-60 60,-60 60,-9 -60,9" transform="rotate(-20)"/></clipPath></defs></svg>';
    document.body.prepend(holder);
  }

  mountDefs();

  window.LANES = {
    KINDS,
    NAME,
    STOP,
    VEH,
    stopScale,
    stopKind,
    routeKind,
    operatorKind,
    stopIcon,
    badgeIcon,
    vehHtml,
    circleStyle,
    lineStyle,
    legendHtml,
    css: cssVar,
  };
})();
