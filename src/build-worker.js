import { workerData } from "node:worker_threads";
import { build } from "./ingest.js";

// Buffers arrive as plain Uint8Array after structured clone; readZip needs Buffer methods.
const zips = workerData.zips.map(({ feed, buffer }) => ({ feed, buffer: Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength) }));
build(workerData.dbPath, zips).close();
