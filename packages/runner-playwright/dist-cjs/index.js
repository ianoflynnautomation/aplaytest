"use strict";
/**
 * @atest/runner-playwright — the Playwright adapter.
 *
 * The only package that knows Playwright exists. Everything above it consumes
 * EvidenceBundles and RunRecords, so swapping in a different runner means
 * writing a sibling of this package and nothing else.
 *
 * NOTE: this package must NOT depend on @atest/llm. The reporter runs inside
 * the test process; pulling an HTTP client and a model SDK into every worker
 * would be both slow and a place a credential should never be.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.escapeForGrep = exports.runPlaywright = exports.IntentSidecarSchema = exports.ConsoleSidecarSchema = exports.NetworkSidecarSchema = exports.PageSidecarSchema = exports.SidecarParseError = exports.parseSidecar = exports.SIDECAR = exports.domainStringArgs = exports.parseStepTitle = exports.findFailingStep = exports.extractSteps = exports.previewValue = exports.previewArgs = exports.bindPage = exports.createCaptureFixture = exports.atestFixtures = exports.stripAnsi = exports.splitCallLog = exports.parsePlaywrightError = exports.classifyResult = exports.toClassifiable = exports.assembleBundle = exports.ATEST_VERSION = exports.AtestReporter = void 0;
var reporter_js_1 = require("./reporter.js");
Object.defineProperty(exports, "AtestReporter", { enumerable: true, get: function () { return __importDefault(reporter_js_1).default; } });
Object.defineProperty(exports, "ATEST_VERSION", { enumerable: true, get: function () { return reporter_js_1.ATEST_VERSION; } });
var assemble_js_1 = require("./assemble.js");
Object.defineProperty(exports, "assembleBundle", { enumerable: true, get: function () { return assemble_js_1.assembleBundle; } });
Object.defineProperty(exports, "toClassifiable", { enumerable: true, get: function () { return assemble_js_1.toClassifiable; } });
Object.defineProperty(exports, "classifyResult", { enumerable: true, get: function () { return assemble_js_1.classifyResult; } });
var errors_js_1 = require("./errors.js");
Object.defineProperty(exports, "parsePlaywrightError", { enumerable: true, get: function () { return errors_js_1.parsePlaywrightError; } });
Object.defineProperty(exports, "splitCallLog", { enumerable: true, get: function () { return errors_js_1.splitCallLog; } });
Object.defineProperty(exports, "stripAnsi", { enumerable: true, get: function () { return errors_js_1.stripAnsi; } });
var fixtures_js_1 = require("./fixtures.js");
Object.defineProperty(exports, "atestFixtures", { enumerable: true, get: function () { return fixtures_js_1.atestFixtures; } });
Object.defineProperty(exports, "createCaptureFixture", { enumerable: true, get: function () { return fixtures_js_1.createCaptureFixture; } });
var bind_js_1 = require("./bind.js");
Object.defineProperty(exports, "bindPage", { enumerable: true, get: function () { return bind_js_1.bindPage; } });
Object.defineProperty(exports, "previewArgs", { enumerable: true, get: function () { return bind_js_1.previewArgs; } });
Object.defineProperty(exports, "previewValue", { enumerable: true, get: function () { return bind_js_1.previewValue; } });
var steps_js_1 = require("./steps.js");
Object.defineProperty(exports, "extractSteps", { enumerable: true, get: function () { return steps_js_1.extractSteps; } });
Object.defineProperty(exports, "findFailingStep", { enumerable: true, get: function () { return steps_js_1.findFailingStep; } });
Object.defineProperty(exports, "parseStepTitle", { enumerable: true, get: function () { return steps_js_1.parseStepTitle; } });
Object.defineProperty(exports, "domainStringArgs", { enumerable: true, get: function () { return steps_js_1.domainStringArgs; } });
var sidecar_js_1 = require("./sidecar.js");
Object.defineProperty(exports, "SIDECAR", { enumerable: true, get: function () { return sidecar_js_1.SIDECAR; } });
Object.defineProperty(exports, "parseSidecar", { enumerable: true, get: function () { return sidecar_js_1.parseSidecar; } });
Object.defineProperty(exports, "SidecarParseError", { enumerable: true, get: function () { return sidecar_js_1.SidecarParseError; } });
Object.defineProperty(exports, "PageSidecarSchema", { enumerable: true, get: function () { return sidecar_js_1.PageSidecarSchema; } });
Object.defineProperty(exports, "NetworkSidecarSchema", { enumerable: true, get: function () { return sidecar_js_1.NetworkSidecarSchema; } });
Object.defineProperty(exports, "ConsoleSidecarSchema", { enumerable: true, get: function () { return sidecar_js_1.ConsoleSidecarSchema; } });
Object.defineProperty(exports, "IntentSidecarSchema", { enumerable: true, get: function () { return sidecar_js_1.IntentSidecarSchema; } });
var spawn_js_1 = require("./spawn.js");
Object.defineProperty(exports, "runPlaywright", { enumerable: true, get: function () { return spawn_js_1.runPlaywright; } });
Object.defineProperty(exports, "escapeForGrep", { enumerable: true, get: function () { return spawn_js_1.escapeForGrep; } });
//# sourceMappingURL=index.js.map