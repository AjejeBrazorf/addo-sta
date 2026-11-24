(function () {
  const PALETTES = {
    dark: {
      land: "#46506b",
      park: "#414a64",
      wood: "#3e475f",
      water: "#373f56",
      waterLine: "#373f56",
      building: "#3e4760",
      buildingEdge: "#3a4258",
      pathLine: "#3b4359",
      minor: "#3a4259",
      major: "#363d54",
      motorway: "#30374d",
      rail: "#3b4359",
      label: "#7f9bb8",
      labelStrong: "#a9bdd4",
      labelWater: "#5d7694",
      road: "#6b7f99",
      halo: "#46506b",
      haloWater: "#373f56",
    },
    light: {
      land: "#e5eaf1",
      park: "#dae5e3",
      wood: "#d4e0de",
      water: "#c3d3e4",
      waterLine: "#c3d3e4",
      building: "#dde3ec",
      buildingEdge: "#d3dae5",
      pathLine: "#d8dfe9",
      minor: "#f6f8fb",
      major: "#fbfcfd",
      motorway: "#ffffff",
      rail: "#cfd7e3",
      label: "#69809d",
      labelStrong: "#46607f",
      labelWater: "#6f8fb2",
      road: "#7a8aa1",
      halo: "#e5eaf1",
      haloWater: "#c3d3e4",
    },
  };

  const NAME = ["coalesce", ["get", "name"], ["get", "name_en"]];
  const POINT = ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false];
  const LINE = ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false];
  const POLY = ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false];
  const SIZE = (base, extra) => ["interpolate", ["exponential", 1.4], ["zoom"], 8, base * 0.3, 13, base, 20, base * extra];
  const FONT = ["Noto Sans Regular"];

  function style(theme) {
    const c = PALETTES[theme] || PALETTES.dark;
    const road = (id, classes, color, width, minzoom, extra = {}) => ({
      id,
      type: "line",
      source: "ofm",
      "source-layer": "transportation",
      minzoom,
      filter: ["all", LINE, ["match", ["get", "class"], classes, true, false], ["!=", ["get", "brunnel"], "tunnel"]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": color, "line-width": width, ...extra },
    });
    const place = (id, filter, size, color, extra = {}, maxzoom = 24) => ({
      id,
      type: "symbol",
      source: "ofm",
      "source-layer": "place",
      maxzoom,
      filter: ["all", POINT, filter],
      layout: {
        "text-field": NAME,
        "text-font": FONT,
        "text-size": size,
        "text-transform": "uppercase",
        "text-letter-spacing": 0.06,
        "text-max-width": 7,
        ...extra,
      },
      paint: { "text-color": color, "text-halo-color": c.halo, "text-halo-width": 1.4, "text-halo-blur": 0.4 },
    });

    return {
      version: 8,
      glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
      sources: { ofm: { type: "vector", url: "https://tiles.openfreemap.org/planet", attribution: "" } },
      layers: [
        { id: "background", type: "background", paint: { "background-color": c.land } },
        {
          id: "wood",
          type: "fill",
          source: "ofm",
          "source-layer": "landcover",
          filter: ["all", POLY, ["match", ["get", "class"], ["wood", "grass", "farmland"], true, false]],
          paint: { "fill-color": c.wood, "fill-opacity": 0.55 },
        },
        {
          id: "park",
          type: "fill",
          source: "ofm",
          "source-layer": "landuse",
          filter: ["all", POLY, ["match", ["get", "class"], ["park", "cemetery", "pitch", "playground", "stadium", "garden", "grass"], true, false]],
          paint: { "fill-color": c.park },
        },
        { id: "water", type: "fill", source: "ofm", "source-layer": "water", paint: { "fill-color": c.water } },
        {
          id: "waterway",
          type: "line",
          source: "ofm",
          "source-layer": "waterway",
          filter: LINE,
          paint: { "line-color": c.waterLine, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.6, 18, 4] },
        },
        {
          id: "building",
          type: "fill",
          source: "ofm",
          "source-layer": "building",
          minzoom: 14,
          paint: { "fill-color": c.building, "fill-outline-color": c.buildingEdge, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 15.5, 1] },
        },
        {
          id: "aeroway",
          type: "line",
          source: "ofm",
          "source-layer": "aeroway",
          filter: ["all", LINE, ["match", ["get", "class"], ["runway", "taxiway"], true, false]],
          paint: { "line-color": c.major, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 16, 18] },
        },
        road("path", ["path", "pedestrian"], c.pathLine, ["interpolate", ["exponential", 1.3], ["zoom"], 14, 0.5, 20, 4], 14, { "line-opacity": 0.8 }),
        road("minor", ["minor", "service", "track"], c.minor, SIZE(1.25, 14), 10),
        road("street", ["tertiary", "secondary", "primary", "trunk"], c.major, SIZE(2.4, 14), 8),
        road("motorway", ["motorway"], c.motorway, SIZE(3.2, 12), 6),
        {
          id: "rail",
          type: "line",
          source: "ofm",
          "source-layer": "transportation",
          minzoom: 12,
          filter: ["all", LINE, ["match", ["get", "class"], ["rail", "transit"], true, false], ["!", ["has", "service"]], ["!=", ["get", "brunnel"], "tunnel"]],
          paint: { "line-color": c.rail, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.8, 18, 3] },
        },
        {
          id: "water-name",
          type: "symbol",
          source: "ofm",
          "source-layer": "water_name",
          filter: LINE,
          layout: { "symbol-placement": "line", "text-field": NAME, "text-font": FONT, "text-size": 11, "text-letter-spacing": 0.2 },
          paint: { "text-color": c.labelWater, "text-halo-color": c.haloWater, "text-halo-width": 1 },
        },
        {
          id: "water-name-point",
          type: "symbol",
          source: "ofm",
          "source-layer": "water_name",
          filter: POINT,
          layout: { "text-field": NAME, "text-font": FONT, "text-size": 11, "text-letter-spacing": 0.2, "text-transform": "uppercase", "text-max-width": 8 },
          paint: { "text-color": c.labelWater, "text-halo-color": c.haloWater, "text-halo-width": 1 },
        },
        {
          id: "road-name",
          type: "symbol",
          source: "ofm",
          "source-layer": "transportation_name",
          minzoom: 15,
          filter: LINE,
          layout: { "symbol-placement": "line", "text-field": NAME, "text-font": FONT, "text-size": 10, "text-letter-spacing": 0.04, "text-max-angle": 30, "text-transform": "uppercase" },
          paint: { "text-color": c.road, "text-halo-color": c.halo, "text-halo-width": 1.2 },
        },
        place("place-small", ["match", ["get", "class"], ["hamlet", "isolated_dwelling", "neighbourhood", "quarter"], true, false], ["interpolate", ["linear"], ["zoom"], 11, 9, 16, 12], c.label, {}, 17),
        place("place-suburb", ["==", ["get", "class"], "suburb"], ["interpolate", ["linear"], ["zoom"], 10, 9.5, 15, 13], c.label, {}, 17),
        place("place-village", ["match", ["get", "class"], ["village", "town"], true, false], ["interpolate", ["linear"], ["zoom"], 8, 10, 14, 13], c.label, {}, 16),
        place("place-city", ["==", ["get", "class"], "city"], ["interpolate", ["linear"], ["zoom"], 6, 11, 12, 16], c.labelStrong, { "text-letter-spacing": 0.14 }, 16),
      ],
    };
  }

  window.basemapStyle = style;
})();
