import { expect } from "chai";
import { HomeWizardWebSocket, type WsCallbacks } from "../src/lib/websocket-client";

interface LogEntry {
    level: string;
    msg: string;
}

interface CallbackTracker {
    measurements: unknown[];
    connected: number;
    disconnected: number;
    disconnectErrors: (Error | undefined)[];
    logs: LogEntry[];
}

function createCallbackTracker(): { callbacks: WsCallbacks; tracker: CallbackTracker } {
    const tracker: CallbackTracker = {
        measurements: [],
        connected: 0,
        disconnected: 0,
        disconnectErrors: [],
        logs: [],
    };

    const callbacks: WsCallbacks = {
        onMeasurement: (data) => {
            tracker.measurements.push(data);
        },
        onConnected: () => {
            tracker.connected++;
        },
        onDisconnected: (error) => {
            tracker.disconnected++;
            tracker.disconnectErrors.push(error);
        },
        log: {
            debug: (msg: string) => {
                tracker.logs.push({ level: "debug", msg });
            },
            warn: (msg: string) => {
                tracker.logs.push({ level: "warn", msg });
            },
        },
    };

    return { callbacks, tracker };
}

describe("HomeWizardWebSocket", () => {
    describe("constructor", () => {
        it("should create an instance", () => {
            const { callbacks } = createCallbackTracker();
            const ws = new HomeWizardWebSocket("192.168.1.1", "testtoken", callbacks);
            expect(ws).to.be.instanceOf(HomeWizardWebSocket);
            ws.close();
        });

        it("should not be connected initially", () => {
            const { callbacks } = createCallbackTracker();
            const ws = new HomeWizardWebSocket("192.168.1.1", "testtoken", callbacks);
            expect(ws.isConnected).to.be.false;
            ws.close();
        });
    });

    describe("close", () => {
        it("should not throw when called before connect", () => {
            const { callbacks } = createCallbackTracker();
            const ws = new HomeWizardWebSocket("192.168.1.1", "testtoken", callbacks);
            expect(() => ws.close()).to.not.throw();
        });

        it("should not throw when called multiple times", () => {
            const { callbacks } = createCallbackTracker();
            const ws = new HomeWizardWebSocket("192.168.1.1", "testtoken", callbacks);
            ws.close();
            expect(() => ws.close()).to.not.throw();
        });

        it("should prevent reconnect after close", () => {
            const { callbacks } = createCallbackTracker();
            const ws = new HomeWizardWebSocket("192.168.1.1", "testtoken", callbacks);
            ws.close();
            // connect after close should be a no-op (destroyed flag)
            ws.connect();
            expect(ws.isConnected).to.be.false;
        });
    });

    describe("handleMessage (via internal access)", () => {
        function callHandleMessage(ws: HomeWizardWebSocket, msg: unknown): void {
            const raw = Buffer.from(JSON.stringify(msg));
            (ws as unknown as { handleMessage: (raw: Buffer) => void }).handleMessage(raw);
        }

        it("should handle authorization_requested by sending token", () => {
            const { callbacks, tracker } = createCallbackTracker();
            const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

            callHandleMessage(ws, {
                type: "authorization_requested",
                data: { api_version: "2.0.0" },
            });

            const debugLogs = tracker.logs.filter((l) => l.level === "debug");
            expect(debugLogs.some((l) => l.msg.includes("auth requested"))).to.be.true;
            ws.close();
        });

        it("should handle authorized by calling onConnected", () => {
            const { callbacks, tracker } = createCallbackTracker();
            const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

            callHandleMessage(ws, { type: "authorized" });

            expect(tracker.connected).to.equal(1);
            ws.close();
        });

        it("should handle measurement by calling onMeasurement", () => {
            const { callbacks, tracker } = createCallbackTracker();
            const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

            const measurementData = {
                power_w: 1234,
                energy_import_kwh: 5678.9,
            };
            callHandleMessage(ws, { type: "measurement", data: measurementData });

            expect(tracker.measurements).to.have.length(1);
            expect(tracker.measurements[0]).to.deep.equal(measurementData);
            ws.close();
        });

        it("should ignore measurement without data", () => {
            const { callbacks, tracker } = createCallbackTracker();
            const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

            callHandleMessage(ws, { type: "measurement" });

            expect(tracker.measurements).to.have.length(0);
            ws.close();
        });

        it("should warn on non-object root message (array)", () => {
            const { callbacks, tracker } = createCallbackTracker();
            const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

            callHandleMessage(ws, ["measurement"]);

            const warnLogs = tracker.logs.filter((l) => l.level === "warn");
            expect(warnLogs.some((l) => l.msg.includes("non-object"))).to.be.true;
            ws.close();
        });

        it("should warn on root message as string", () => {
            const { callbacks, tracker } = createCallbackTracker();
            const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

            const raw = Buffer.from(JSON.stringify("just a string"));
            (ws as unknown as { handleMessage: (raw: Buffer) => void }).handleMessage(raw);

            const warnLogs = tracker.logs.filter((l) => l.level === "warn");
            expect(warnLogs.some((l) => l.msg.includes("non-object"))).to.be.true;
            ws.close();
        });

        it("should warn on message without string type", () => {
            const { callbacks, tracker } = createCallbackTracker();
            const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

            callHandleMessage(ws, { type: 42, data: {} });

            const warnLogs = tracker.logs.filter((l) => l.level === "warn");
            expect(warnLogs.some((l) => l.msg.includes("string type"))).to.be.true;
            ws.close();
        });

        it("should warn on measurement with non-object data (string)", () => {
            const { callbacks, tracker } = createCallbackTracker();
            const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

            callHandleMessage(ws, { type: "measurement", data: "corrupt" });

            expect(tracker.measurements).to.have.length(0);
            const warnLogs = tracker.logs.filter((l) => l.level === "warn");
            expect(warnLogs.some((l) => l.msg.includes("object payload"))).to.be.true;
            ws.close();
        });

        it("should warn on measurement with array data", () => {
            const { callbacks, tracker } = createCallbackTracker();
            const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

            callHandleMessage(ws, { type: "measurement", data: [1, 2, 3] });

            expect(tracker.measurements).to.have.length(0);
            const warnLogs = tracker.logs.filter((l) => l.level === "warn");
            expect(warnLogs.some((l) => l.msg.includes("object payload"))).to.be.true;
            ws.close();
        });

        it("should warn on measurement with null data", () => {
            const { callbacks, tracker } = createCallbackTracker();
            const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

            callHandleMessage(ws, { type: "measurement", data: null });

            expect(tracker.measurements).to.have.length(0);
            ws.close();
        });

        it("should handle unknown message types gracefully", () => {
            const { callbacks, tracker } = createCallbackTracker();
            const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

            callHandleMessage(ws, { type: "unknown_type", data: {} });

            const debugLogs = tracker.logs.filter((l) => l.level === "debug");
            expect(debugLogs.some((l) => l.msg.includes("unknown_type"))).to.be.true;
            ws.close();
        });

        it("should warn on invalid JSON", () => {
            const { callbacks, tracker } = createCallbackTracker();
            const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

            const raw = Buffer.from("not json at all");
            (ws as unknown as { handleMessage: (raw: Buffer) => void }).handleMessage(raw);

            const warnLogs = tracker.logs.filter((l) => l.level === "warn");
            expect(warnLogs.some((l) => l.msg.includes("invalid JSON"))).to.be.true;
            ws.close();
        });

        it("should handle multiple measurements in sequence", () => {
            const { callbacks, tracker } = createCallbackTracker();
            const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

            callHandleMessage(ws, { type: "measurement", data: { power_w: 100 } });
            callHandleMessage(ws, { type: "measurement", data: { power_w: 200 } });
            callHandleMessage(ws, { type: "measurement", data: { power_w: 300 } });

            expect(tracker.measurements).to.have.length(3);
            expect((tracker.measurements[2] as { power_w: number }).power_w).to.equal(300);
            ws.close();
        });
    });

    describe("full auth flow simulation", () => {
        function callHandleMessage(ws: HomeWizardWebSocket, msg: unknown): void {
            const raw = Buffer.from(JSON.stringify(msg));
            (ws as unknown as { handleMessage: (raw: Buffer) => void }).handleMessage(raw);
        }

        it("should complete auth flow: auth_requested → authorized → measurement", () => {
            const { callbacks, tracker } = createCallbackTracker();
            const ws = new HomeWizardWebSocket("192.168.1.1", "mytoken", callbacks);

            // Step 1: Device requests auth
            callHandleMessage(ws, {
                type: "authorization_requested",
                data: { api_version: "2.0.0" },
            });
            expect(tracker.connected).to.equal(0); // Not yet connected

            // Step 2: Device confirms auth
            callHandleMessage(ws, { type: "authorized" });
            expect(tracker.connected).to.equal(1); // Now connected

            // Step 3: Measurement data flows
            callHandleMessage(ws, {
                type: "measurement",
                data: { power_w: 456, voltage_l1_v: 230.1 },
            });
            expect(tracker.measurements).to.have.length(1);
            expect((tracker.measurements[0] as { power_w: number }).power_w).to.equal(456);

            ws.close();
        });
    });
});
