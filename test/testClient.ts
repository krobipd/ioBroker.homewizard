import { expect } from "chai";
import { HomeWizardApiError } from "../src/lib/homewizard-client";

describe("HomeWizardApiError", () => {
    describe("JSON error body", () => {
        it("should parse error code from nested error object", () => {
            const body = JSON.stringify({
                error: { code: "user:unauthorized", description: "Token invalid" },
            });
            const err = new HomeWizardApiError(401, body, "GET /api");
            expect(err.statusCode).to.equal(401);
            expect(err.errorCode).to.equal("user:unauthorized");
            expect(err.message).to.include("Token invalid");
            expect(err.message).to.include("401");
            expect(err.name).to.equal("HomeWizardApiError");
        });

        it("should parse error code from flat error string", () => {
            const body = JSON.stringify({ error: "user:creation-not-enabled" });
            const err = new HomeWizardApiError(403, body, "POST /api/user");
            expect(err.errorCode).to.equal("user:creation-not-enabled");
            expect(err.message).to.include("403");
        });

        it("should use code as description when no description field", () => {
            const body = JSON.stringify({
                error: { code: "request:too-large" },
            });
            const err = new HomeWizardApiError(413, body, "PUT /api/system");
            expect(err.errorCode).to.equal("request:too-large");
            expect(err.message).to.include("request:too-large");
        });

        it("should handle empty error object", () => {
            const body = JSON.stringify({ error: {} });
            const err = new HomeWizardApiError(500, body, "GET /api");
            // {} has no code property → falls through to parsed.error itself
            expect(err.statusCode).to.equal(500);
        });
    });

    describe("non-JSON error body", () => {
        it("should use raw body as description", () => {
            const err = new HomeWizardApiError(500, "Internal Server Error", "GET /api");
            expect(err.errorCode).to.equal("unknown");
            expect(err.message).to.include("Internal Server Error");
            expect(err.message).to.include("500");
        });

        it("should handle empty body", () => {
            const err = new HomeWizardApiError(404, "", "GET /api/missing");
            expect(err.errorCode).to.equal("unknown");
            expect(err.message).to.include("404");
        });
    });

    describe("context in message", () => {
        it("should include method and path", () => {
            const err = new HomeWizardApiError(401, "{}", "GET /api/measurement");
            expect(err.message).to.include("GET /api/measurement");
        });
    });

    describe("instanceof", () => {
        it("should be an instance of Error", () => {
            const err = new HomeWizardApiError(500, "{}", "GET /api");
            expect(err).to.be.instanceOf(Error);
        });

        it("should be an instance of HomeWizardApiError", () => {
            const err = new HomeWizardApiError(500, "{}", "GET /api");
            expect(err).to.be.instanceOf(HomeWizardApiError);
        });
    });
});
