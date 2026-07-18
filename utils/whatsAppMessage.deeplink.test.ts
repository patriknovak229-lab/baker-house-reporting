import { describe, it, expect, afterEach, vi } from "vitest";
import { buildWhatsAppDeeplink, isMobileDevice } from "./whatsAppMessage";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const IPAD_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_WHATSAPP_URL_BASE;
});

describe("isMobileDevice", () => {
  it("is false with no navigator (server) and on desktop", () => {
    expect(isMobileDevice()).toBe(false); // node: navigator undefined
    vi.stubGlobal("navigator", { userAgent: MAC_UA, maxTouchPoints: 0 });
    expect(isMobileDevice()).toBe(false);
  });

  it("is true on iPhone and touch iPad (which reports as Macintosh)", () => {
    vi.stubGlobal("navigator", { userAgent: IPHONE_UA, maxTouchPoints: 5 });
    expect(isMobileDevice()).toBe(true);
    vi.stubGlobal("navigator", { userAgent: IPAD_UA, maxTouchPoints: 5 });
    expect(isMobileDevice()).toBe(true);
  });
});

describe("buildWhatsAppDeeplink", () => {
  it("uses wa.me (native-app handoff) on mobile", () => {
    vi.stubGlobal("navigator", { userAgent: IPHONE_UA, maxTouchPoints: 5 });
    expect(buildWhatsAppDeeplink("+420 777 123 456", "hi")).toBe("https://wa.me/420777123456?text=hi");
  });

  it("uses web.whatsapp.com (Business browser profile) on desktop", () => {
    vi.stubGlobal("navigator", { userAgent: MAC_UA, maxTouchPoints: 0 });
    expect(buildWhatsAppDeeplink("420777123456", "hi")).toBe(
      "https://web.whatsapp.com/send?phone=420777123456&text=hi",
    );
  });

  it("honours an explicit env override regardless of device", () => {
    process.env.NEXT_PUBLIC_WHATSAPP_URL_BASE = "wa.me";
    vi.stubGlobal("navigator", { userAgent: MAC_UA, maxTouchPoints: 0 }); // desktop
    expect(buildWhatsAppDeeplink("420777123456", "hi")).toBe("https://wa.me/420777123456?text=hi");
  });

  it("encodes the text and strips the leading + from the phone", () => {
    vi.stubGlobal("navigator", { userAgent: IPHONE_UA, maxTouchPoints: 5 });
    expect(buildWhatsAppDeeplink("+420777123456", "a b&c")).toBe("https://wa.me/420777123456?text=a%20b%26c");
  });

  it("throws on an unusable phone number", () => {
    expect(() => buildWhatsAppDeeplink("123", "hi")).toThrow();
  });
});
