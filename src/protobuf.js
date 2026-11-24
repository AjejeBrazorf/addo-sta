// Minimal GTFS-Realtime decoder: only the fields realtime.js reads, shaped like
// protobufjs toObject({ longs: Number, enums: String }) (absent fields stay absent).
// ponytail: unlisted fields are skipped; add them to SCHEMA when realtime.js needs them.

const SCHEDULE_RELATIONSHIP = ["SCHEDULED", "SKIPPED", "NO_DATA", "UNSCHEDULED"];

// field number -> [name, type, repeated]
const SCHEMA = {
  FeedMessage: { 1: ["header", "FeedHeader"], 2: ["entity", "FeedEntity", true] },
  FeedHeader: { 3: ["timestamp", "uint64"] },
  FeedEntity: { 1: ["id", "string"], 3: ["tripUpdate", "TripUpdate"], 4: ["vehicle", "VehiclePosition"] },
  TripUpdate: { 1: ["trip", "TripDescriptor"], 2: ["stopTimeUpdate", "StopTimeUpdate", true] },
  StopTimeUpdate: {
    2: ["arrival", "StopTimeEvent"],
    3: ["departure", "StopTimeEvent"],
    4: ["stopId", "string"],
    5: ["scheduleRelationship", SCHEDULE_RELATIONSHIP],
  },
  StopTimeEvent: { 1: ["delay", "int32"], 2: ["time", "int64"] },
  VehiclePosition: {
    1: ["trip", "TripDescriptor"],
    2: ["position", "Position"],
    5: ["timestamp", "uint64"],
    8: ["vehicle", "VehicleDescriptor"],
  },
  TripDescriptor: { 1: ["tripId", "string"], 5: ["routeId", "string"] },
  VehicleDescriptor: { 1: ["id", "string"] },
  Position: { 1: ["latitude", "float"], 2: ["longitude", "float"], 3: ["bearing", "float"], 5: ["speed", "float"] },
};

const utf8 = new TextDecoder();

function decodeMessage(bytes, start, end, type) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fields = SCHEMA[type];
  const out = {};
  let pos = start;
  const varint = () => {
    let value = 0n;
    let shift = 0n;
    let byte;
    do {
      if (pos >= end) throw new Error("protobuf: truncated varint");
      byte = bytes[pos++];
      value |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
    } while (byte & 0x80);
    return value;
  };
  while (pos < end) {
    const key = Number(varint());
    const wire = key & 7;
    const field = fields[key >>> 3];
    let value;
    if (wire === 0) value = varint();
    else if (wire === 1) pos += 8;
    else if (wire === 5) value = pos += 4;
    else if (wire === 2) {
      const len = Number(varint());
      if (pos + len > end) throw new Error("protobuf: truncated field");
      value = [pos, pos + len];
      pos += len;
    } else throw new Error(`protobuf: unsupported wire type ${wire}`);
    if (pos > end) throw new Error("protobuf: truncated field");
    if (!field) continue;
    const [name, kind, repeated] = field;
    if (wire !== (kind === "float" ? 5 : kind === "string" || SCHEMA[kind] ? 2 : 0)) continue;
    let decoded;
    if (Array.isArray(kind)) decoded = SCHEDULE_RELATIONSHIP[Number(value)] ?? Number(BigInt.asIntN(32, value));
    else if (kind === "uint64") decoded = Number(BigInt.asUintN(64, value));
    else if (kind === "int64") decoded = Number(BigInt.asIntN(64, value));
    else if (kind === "int32") decoded = Number(BigInt.asIntN(32, value));
    else if (kind === "float") decoded = view.getFloat32(value - 4, true);
    else if (kind === "string") decoded = utf8.decode(bytes.subarray(value[0], value[1]));
    else decoded = decodeMessage(bytes, value[0], value[1], kind);
    if (repeated) (out[name] ||= []).push(decoded);
    else out[name] = decoded;
  }
  return out;
}

/** Decode a GTFS-Realtime FeedMessage buffer (Buffer/Uint8Array). */
export function decodeFeed(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return decodeMessage(bytes, 0, bytes.length, "FeedMessage");
}
