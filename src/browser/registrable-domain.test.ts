import { describe, expect, it } from "vitest";
import { registrableDomain } from "./registrable-domain.js";

describe("registrableDomain", () => {
	it("resolves ordinary and multipart public suffixes", () => {
		expect(registrableDomain("app.example.com")).toBe("example.com");
		expect(registrableDomain("api.foo.co.uk")).toBe("foo.co.uk");
		expect(registrableDomain("shop.example.com.au")).toBe("example.com.au");
	});

	it("returns null when no registrable domain exists", () => {
		expect(registrableDomain("localhost")).toBeNull();
		expect(registrableDomain("127.0.0.1")).toBeNull();
		expect(registrableDomain("co.uk")).toBeNull();
	});

	it("keeps private-suffix tenants separate", () => {
		expect(registrableDomain("victim.herokuapp.com")).toBe("victim.herokuapp.com");
		expect(registrableDomain("attacker.herokuapp.com")).toBe("attacker.herokuapp.com");
		expect(registrableDomain("app.vercel.app")).toBe("app.vercel.app");
		expect(registrableDomain("herokuapp.com")).toBeNull();
	});
});
