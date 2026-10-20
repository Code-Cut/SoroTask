// Keeper logger with W3C trace context injection and first-class structured logging.
// Supports: structured application-level logging, correlation ID propagation, and
// OpenTelemetry-compatible span export for distributed tracing across frontend, API
// gateway, keeper priority queue, and Soroban contract execution.

const DEFAULT_OPTIONS = {
  level: 'info', // 'error' | 'warn' | 'info' | 'debug'
  enabled: true,
  serviceName: 'keeper',
  version: '1.0.0',
  environment: process.env.NODE_ENV || 'development',
  exporter: ensureConsoleExporter(),
  correlationHeader: 'x-correlation-id',
  correlationCookie: 'x-correlation-id',
  sampler: samplerAlways,
  spanStore: new InMemorySpanStore(),
};

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const DEFAULT_SAMPLER = DEFAULT_OPTIONS.sampler;

// ------------------------------------------------------------------
// SoroLabs Distributed Tracing Logger — full-mesh correlation from
// frontend user actions → API gateway → keeper priority queue →
// Soroban contract execution event (W3C trace context).
//
// Target issue: #1474 [BE-PROD-50]
// ------------------------------------------------------------------

let _currentTraceId = null;
let _currentSpanId = null;
let _correlationId = null;

function createTraceId() {
  return randomHex(32);
}

function createSpanId() {
  return randomHex(16);
}

function currentTraceId() {
  return _currentTraceId;
}

function currentSpanId() {
  return _currentSpanId;
}

function currentCorrelationId() {
  return _correlationId;
}

function setCurrentTraceContext(traceId, spanId, correlationId = null) {
  _currentTraceId = traceId;
  _currentSpanId = spanId;
  _correlationId = correlationId;
}

function makeRootSpan(name, attributes = {}, startTime = Date.now()) {
  const traceId = createTraceId();
  const spanId = createSpanId();
  const span = {
    name,
    traceId,
    spanId,
    parentSpanId: null,
    kind: 'server',
    status: { code: 'unset' },
    startTime: startTime || Date.now(),
    endTime: null,
    attributes,
    events: [],
    links: [],
    resource: {
      attributes: {
        'service.name': DEFAULT_OPTIONS.serviceName,
        'service.version': DEFAULT_OPTIONS.version,
        'deployment.environment': DEFAULT_OPTIONS.environment,
        'telemetry.sdk.language': 'nodejs',
        'telemetry.sdk.name': 'opentelemetry',
        'telemetry.sdk.version': '1.0.0',
      },
    },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    codeLocation: { column: 0, file: 'keeper/src/logger.js', line: 1 },
  };
  setCurrentTraceContext(traceId, spanId, extractCorrelationId(attributes) ?? correlationIdFromEnvOrHeader());
  return span;
}

function makeChildSpan(name, attributes = {}, startTime = Date.now()) {
  const parentSpanId = currentSpanId();
  const traceId = currentTraceId();
  const spanId = createSpanId();
  const correlationId = currentCorrelationId();
  const span = {
    name,
    traceId,
    spanId,
    parentSpanId,
    kind: 'internal',
    status: { code: 'unset' },
    startTime: startTime || Date.now(),
    endTime: null,
    attributes: { ...attributes },
    events: [],
    links: [],
    resource: {
      attributes: {
        'service.name': DEFAULT_OPTIONS.serviceName,
        'service.version': DEFAULT_OPTIONS.version,
        'deployment.environment': DEFAULT_OPTIONS.environment,
        'telemetry.sdk.language': 'nodejs',
        'telemetry.sdk.name': 'opentelemetry',
        'telemetry.sdk.version': '1.0.0',
      },
    },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    codeLocation: { column: 0, file: 'keeper/src/logger.js', line: 1 },
  };
  if (correlationId) {
    span.attributes['correlation.id'] = correlationId;
  } else if (!span.attributes['correlation.id']) {
    span.attributes['correlation.id'] = correlationIdFromEnvOrHeader();
  }
  return span;
}

function endSpan(span, endTime = Date.now(), status = { code: 'unset' }) {
  span.endTime = endTime;
  span.status = status;
  span._ended = true;
  DEFAULT_OPTIONS.spanStore.add(span);
  DEFAULT_OPTIONS.exporter.export([span]);
  return span;
}

// ------------------------------------------------------------------
// Correlation helpers
// ------------------------------------------------------------------

function correlationIdFromEnvOrHeader() {
  return process.env.CORRELATION_ID || '';
}

function extractCorrelationId(record) {
  if (!record) return null;
  if (record['correlation.id']) return record['correlation.id'];
  if (record.headers && record.headers[DEFAULT_OPTIONS.correlationHeader]) return record.headers[DEFAULT_OPTIONS.correlationHeader];
  if (record.correlationId) return record.correlationId;
  return null;
}

function heartbeat() {
  return {
    ts: new Date().toISOString(),
    service: DEFAULT_OPTIONS.serviceName,
    env: DEFAULT_OPTIONS.environment,
    correlationId: currentCorrelationId() || correlationIdFromEnvOrHeader(),
    traceId: currentTraceId() || null,
    spanId: currentSpanId() || null,
  };
}

// ------------------------------------------------------------------
// Structured logging with correlation propagation
// ------------------------------------------------------------------

function pad(level) {
  const width = 5;
  const str = String(level);
  return str.padEnd(width);
}

function timestamp() {
  return new Date().toISOString();
}

function formatRecord(level, record) {
  const base = {
    timestamp: timestamp(),
    level,
    service: DEFAULT_OPTIONS.serviceName,
    env: DEFAULT_OPTIONS.environment,
    correlationId: currentCorrelationId() || record.correlationId,
    traceId: record.traceId || currentTraceId() || null,
    spanId: record.spanId || currentSpanId() || null,
    message: record.message,
  };
  Object.keys(record).forEach((key) => {
    if (key !== 'message' && key !== 'timestamp' && key !== 'level' && key !== 'service' && key !== 'env' && key !== 'correlationId' && key !== 'traceId' && key !== 'spanId') {
      base[key] = record[key];
    }
  });
  return base;
}

function structured(level, record) {
  if (!DEFAULT_OPTIONS.enabled) return;
  const levelRank = LOG_LEVELS[level];
  if (levelRank < LOG_LEVELS[DEFAULT_OPTIONS.level]) return;
  const formatted = formatRecord(level, record);
  DEFAULT_OPTIONS.exporter.exportLog(fmtLogRecord(formatted));
  return formatted;
}

function info(record) {
  return structured('info', record);
}

function error(record) {
  return structured('error', record);
}

function warn(record) {
  return structured('warn', record);
}

function debug(record) {
  return structured('debug', record);
}

// ------------------------------------------------------------------
// Higher-level helpers to make tracing ergonomic
// ------------------------------------------------------------------

function trace(name, fn, attributes = {}) {
  const span = makeRootSpan ? makeRootSpan(name, attributes) : makeRootSpan(name, attributes);
  try {
    const result = fn(span);
    endSpan(span, Date.now(), { code: 'ok' });
    return result;
  } catch (err) {
    span.endTime = Date.now();
    span.status = { code: 'error', message: err && err.message ? String(err.message) : 'error' };
    DEFAULT_OPTIONS.spanStore.add(span);
    DEFAULT_OPTIONS.exporter.export([span]);
    throw err;
  }
}

function span(name, attributes = {}) {
  return makeChildSpan(name, attributes);
}

// ------------------------------------------------------------------
// In-Memory Span Store (for demo / export / diagnostics)
// ------------------------------------------------------------------

class InMemorySpanStore {
  constructor() {
    this._spans = [];
  }
  add(span) {
    this._spans.push(span);
    if (this._spans.length > 10000) {
      this._spans = this._spans.slice(-5000);
    }
  }
  getAll() {
    return this._spans.slice();
  }
}

// ------------------------------------------------------------------
// Sampler
// ------------------------------------------------------------------

function samplerAlways() {
  return true;
}

// ------------------------------------------------------------------
// Console Exporter (production-safe console fallback)
// ------------------------------------------------------------------

class ConsoleExporter {
  constructor({ includeAttributes = true } = {}) {
    this.includeAttributes = includeAttributes;
  }
  export(span) {
    if (span._ended) {
      console.log(JSON.stringify({
        resourceLogs: [{
          resource: span.resource,
          scopeLogs: [{
            scope: { name: DEFAULT_OPTIONS.serviceName, version: DEFAULT_OPTIONS.version },
            logRecords: span.events.map((e) => ({
              attributes: e.attributes,
              body: e.body,
              severityNumber: severityNumberForLevel(e.severityText),
              timestamp: e.time 기흥구,
            })),
          }],
        }],
        schemaUrl: 'https://opentelemetry.io/schemas/1.21.0',
      }));
    }
  }
  exportLog(record) {
    console.log(JSON.stringify(record));
  }
}

function severityNumberForLevel(level) {
  switch (level) {
    case 'TRACE': return 12;
    case 'DEBUG': return 11;
    case 'INFO': return 9;
    case 'WARN': return 7;
    case 'ERROR': return 1;
    default: return 9;
  }
}

function ensureConsoleExporter() {
  return new ConsoleExporter();
}

// ------------------------------------------------------------------
// OTLP-like batch export helper (used by tests / export paths)
// ------------------------------------------------------------------

async function exportSpans(spans, exporter) {
  exporter = exporter || DEFAULT_OPTIONS.exporter;
  return exporter.export(spans);
}

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

const logger = {
  info,
  error,
  warn,
  debug,
  trace,
  span,
  heartbeat,
  currentTraceId,
  currentSpanId,
  currentCorrelationId,
  setCurrentTraceContext,
  makeRootSpan,
  makeChildSpan,
  endSpan,
  createTraceId,
  createSpanId,
  extractCorrelationId,
  exportSpans,
  // Backward compatibility aliases
  span: makeChildSpan,
  rootSpan: makeRootSpan,
  endSpan,
};

module.exports = { logger, DEFAULT_OPTIONS, createTraceId, createSpanId, currentTraceId, currentSpanId, currentCorrelationId, setCurrentTraceContext, makeRootSpan, makeChildSpan, endSpan, extractCorrelationId, InMemorySpanStore, ConsoleExporter, severityNumberForLevel };

// ------------------------------------------------------------------
// Exporter for OTLP/gRPC services (kept as a no-op bridge for now)
// ------------------------------------------------------------------

async function otlpGrpcExporter(opts = {}) {
  return { export: async (spans) => { /* bridge to OTLP gRPC if/when enabled */ } };
}

async function otlpHttpExporter(opts = {}) {
  return { export: async (spans) => { /* bridge to OTLP HTTP if/when enabled */ } };
}

module.exports.otlpGrpcExporter = otlpGrpcExporter;
module.exports.otlpHttpExporter = otlpHttpExporter;
