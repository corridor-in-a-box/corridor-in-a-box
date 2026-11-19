import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Send App Scaffold & Permanent Testnet Banner (RFC 0004 §6, #684)", () => {
  const root = process.cwd();

  it("provides a permanent TestnetBanner component with non-dismissible testnet notice", () => {
    const bannerPath = resolve(root, "web/components/send/TestnetBanner.tsx");
    const bannerSource = readFileSync(bannerPath, "utf8");

    // Must explicitly declare testnet notice and no real money
    expect(bannerSource).toContain("Testnet only — no real money");
    expect(bannerSource).toContain("@corridor/service");
    expect(bannerSource).toContain("No real fiat or cryptocurrency is transferred");

    // Accessibility attributes
    expect(bannerSource).toContain('role="alert"');
    expect(bannerSource).toContain('aria-label="Testnet Notice"');

    // Permanent: banner cannot be dismissed, closed, or hidden
    expect(bannerSource).not.toMatch(/onDismiss|onClose|onClick|<button/i);
  });

  it("wraps /send routes in a layout that renders the permanent testnet banner on every screen", () => {
    const layoutPath = resolve(root, "web/app/send/layout.tsx");
    const layoutSource = readFileSync(layoutPath, "utf8");

    expect(layoutSource).toContain("TestnetBanner");
    expect(layoutSource).toContain("<TestnetBanner />");
    expect(layoutSource).toContain("{children}");
    // Layout constraints to avoid horizontal scrolling at 375px
    expect(layoutSource).toContain("overflow-x-hidden");
    expect(layoutSource).toContain("max-w-4xl");
    expect(layoutSource).toContain("px-4");
  });

  it("provides a /send page scaffold with responsive layout", () => {
    const pagePath = resolve(root, "web/app/send/page.tsx");
    const pageSource = readFileSync(pagePath, "utf8");

    expect(pageSource).toContain("Send Payment");
    expect(pageSource).toContain("RFC 0004");
  });

  it("links to /send from the global Navbar", () => {
    const navbarPath = resolve(root, "web/components/layout/Navbar.tsx");
    const navbarSource = readFileSync(navbarPath, "utf8");

    expect(navbarSource).toContain('{ href: "/send", label: "Send" }');
  });
});
