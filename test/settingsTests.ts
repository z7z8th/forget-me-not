/**
 * License: zlib/libpng
 * @author Santo Pfingsten
 * @see https://github.com/Lusito/forget-me-not
 */

import { assert } from "chai";
import { browserMock } from "./browserMock";
import { ensureNotNull, doneHandler, clone, booleanContext, createSpy } from "./testHelpers";
import { settings, defaultSettings, Settings, SettingsMap } from "../src/lib/settings";
import { SettingsTypeMap, CleanupType, RuleDefinition } from "../src/lib/settingsSignature";
import { browser } from "webextension-polyfill-ts";

// generate settings map that is unequal to default settings
const testOverrides: SettingsMap = {};
const invalidOverrides: SettingsMap = {};
for (const key in defaultSettings) {
    const type = typeof (defaultSettings[key]);
    if (type === "boolean")
        testOverrides[key] = !defaultSettings[key];
    else if (type === "number")
        testOverrides[key] = defaultSettings[key] as number + 1;
    else if (key === "version")
        testOverrides[key] = "2.0.0";
    else if (type === "string")
        testOverrides[key] = "test-override";
    else if (key === "rules")
        testOverrides[key] = [{ rule: "*.test-override.com", type: CleanupType.LEAVE }];
    else if (type === "object")
        testOverrides[key] = { "test-override.com": true };
    else
        throw new Error("Unknown settings type");

    if (type === "boolean" || type === "number" || type === "object")
        invalidOverrides[key] = "test-override";
    else if (type === "string")
        invalidOverrides[key] = 42;
    else if (key === "rules") {
        // @ts-ignore
        invalidOverrides[key] = [{ rule: "@@@", type: CleanupType.LEAVE }, "sadasd"];
    }
}

describe("Settings", () => {
    beforeEach(() => browserMock.reset());
    afterEach(() => {
        settings.restoreDefaults();
    });

    describe("testOverrides", () => {
        it("should all be unequal to defaultSettings", () => {
            assert.notDeepEqual(defaultSettings, testOverrides);
        });
    });

    describe("getAll", () => {
        it("should initially return default settings", () => {
            assert.deepEqual(settings.getAll(), defaultSettings);
        });
        it("should return overriden values", () => {
            for (const key in defaultSettings)
                settings.set(key as keyof SettingsTypeMap, clone(testOverrides[key]));
            settings.save();
            assert.deepEqual(settings.getAll(), testOverrides);
        });
    });

    describe("get", () => {
        it("should initially return default settings for each key", () => {
            for (const key in defaultSettings)
                assert.deepEqual(settings.get(key as keyof SettingsTypeMap), defaultSettings[key]);
        });
    });

    describe("set", () => {
        it("should override the default settings", () => {
            for (const key in defaultSettings) {
                settings.set(key as keyof SettingsTypeMap, clone(testOverrides[key]));
                settings.save();
                assert.deepEqual(settings.get(key as keyof SettingsTypeMap), testOverrides[key]);
            }
        });
    });

    describe("setAll", () => {
        it("should override the default settings", () => {
            settings.setAll(clone(testOverrides));
            assert.deepEqual(settings.getAll(), testOverrides);
        });
        it("should not override the default settings if the values are invalid types", () => {
            settings.setAll(clone(invalidOverrides));
            assert.deepEqual(settings.getAll(), defaultSettings);
        });
    });

    describe("restoreDefaults", () => {
        it("should restore the default settings", () => {
            settings.setAll(clone(testOverrides));
            settings.restoreDefaults();
            assert.deepEqual(settings.getAll(), defaultSettings);
        });
    });

    describe("save", () => {
        let settings2: Settings | null = null;
        beforeEach(() => {
            if (!settings2)
                settings2 = new Settings();
        });
        afterEach(() => {
            settings2 = null;
        });
        it("should affect other settings instances", (done) => {
            settings2 = ensureNotNull(settings2);
            assert.deepEqual(settings.get("version"), settings2.get("version"));
            settings.set("version", "woot");
            settings.save().then(doneHandler(() => {
                settings2 = ensureNotNull(settings2);
                assert.strictEqual(settings.get("version"), "woot");
                assert.strictEqual(settings2.get("version"), "woot");
            }, done));
        });
    });

    describe("getCleanupTypeForDomain", () => {
        it("should return the default rule if no rule matches", () => {
            settings.set("rules", [
                { rule: "google.com", type: CleanupType.NEVER },
                { rule: "google.de", type: CleanupType.NEVER },
                { rule: "google.co.uk", type: CleanupType.NEVER },
                { rule: "google.jp", type: CleanupType.NEVER }
            ]);
            settings.save();
            assert.strictEqual(settings.getCleanupTypeForDomain("google.ca"), CleanupType.LEAVE);
        });
        it("should return the correct rule if a rule matches", () => {
            settings.set("rules", [
                { rule: "google.com", type: CleanupType.NEVER },
                { rule: "google.de", type: CleanupType.STARTUP },
                { rule: "google.co.uk", type: CleanupType.LEAVE },
                { rule: "google.jp", type: CleanupType.INSTANTLY }
            ]);
            settings.save();
            assert.strictEqual(settings.getCleanupTypeForDomain("google.com"), CleanupType.NEVER);
            assert.strictEqual(settings.getCleanupTypeForDomain("google.de"), CleanupType.STARTUP);
            assert.strictEqual(settings.getCleanupTypeForDomain("google.co.uk"), CleanupType.LEAVE);
            assert.strictEqual(settings.getCleanupTypeForDomain("google.jp"), CleanupType.INSTANTLY);
        });
        it("should respect the order of matching rules", () => {
            assert.strictEqual(settings.getCleanupTypeForDomain("google.com"), CleanupType.LEAVE);
            const rules: RuleDefinition[] = [];
            function addAndTest(type: CleanupType) {
                rules.push({ rule: "google.com", type });
                settings.set("rules", rules);
                assert.strictEqual(settings.getCleanupTypeForDomain("google.com"), type);
            }
            addAndTest(CleanupType.STARTUP);
            addAndTest(CleanupType.NEVER);
            addAndTest(CleanupType.LEAVE);
            addAndTest(CleanupType.INSTANTLY);
        });
        it("should return NEVER for TLD-less domains if whitelistNoTLD is set", () => {
            assert.strictEqual(settings.getCleanupTypeForDomain("localmachine"), CleanupType.LEAVE);
            settings.set("whitelistNoTLD", true);
            assert.strictEqual(settings.getCleanupTypeForDomain("localmachine"), CleanupType.NEVER);
            settings.set("rules", [{ rule: "hello@localmachine", type: CleanupType.INSTANTLY }]);
            assert.strictEqual(settings.getCleanupTypeForDomain("localmachine"), CleanupType.NEVER);
        });
        it("should return NEVER for empty domains if whitelistFileSystem is set", () => {
            assert.strictEqual(settings.getCleanupTypeForDomain(""), CleanupType.NEVER);
            settings.set("whitelistFileSystem", false);
            assert.strictEqual(settings.getCleanupTypeForDomain(""), CleanupType.LEAVE);
        });
    });

    describe("isDomainProtected", () => {
        booleanContext((ignoreStartupType) => {
            it("should return true if proected", () => {
                settings.set("rules", [
                    { rule: "*.google.com", type: CleanupType.NEVER },
                    { rule: "*.google.de", type: CleanupType.STARTUP },
                    { rule: "*.google.co.uk", type: CleanupType.LEAVE },
                    { rule: "*.google.jp", type: CleanupType.INSTANTLY }
                ]);
                settings.save();
                assert.isTrue(settings.isDomainProtected("www.google.com", true));
                assert.equal(settings.isDomainProtected("www.google.de", ignoreStartupType), !ignoreStartupType);
                assert.isFalse(settings.isDomainProtected("www.google.co.uk", true));
                assert.isFalse(settings.isDomainProtected("www.google.jp", true));
                assert.isFalse(settings.isDomainBlocked("www.amazon.com"));
            });
        });
    });

    describe("isDomainBlocked", () => {
        it("should return true if proected", () => {
            settings.set("rules", [
                { rule: "*.google.com", type: CleanupType.NEVER },
                { rule: "*.google.de", type: CleanupType.STARTUP },
                { rule: "*.google.co.uk", type: CleanupType.LEAVE },
                { rule: "*.google.jp", type: CleanupType.INSTANTLY }
            ]);
            settings.save();
            assert.isFalse(settings.isDomainBlocked("www.google.com"));
            assert.isFalse(settings.isDomainBlocked("www.google.de"));
            assert.isFalse(settings.isDomainBlocked("www.google.co.uk"));
            assert.isTrue(settings.isDomainBlocked("www.google.jp"));
            assert.isFalse(settings.isDomainBlocked("www.amazon.com"));
        });
    });

    describe("getChosenRulesForDomain", () => {
        const catchAllRuleStartup = { rule: "*", type: CleanupType.STARTUP };
        const catchComRuleStartup = { rule: "*.com", type: CleanupType.STARTUP };
        const catchAllRuleNever = { rule: "*", type: CleanupType.NEVER };
        const catchAllRuleLeave = { rule: "*", type: CleanupType.LEAVE };
        const catchAllRuleInstantly = { rule: "*", type: CleanupType.INSTANTLY };
        it("should return an empty array if whitelistFileSystem = true and domain is empty", () => {
            settings.set("rules", [catchAllRuleNever]);
            settings.set("whitelistFileSystem", true);
            assert.isEmpty(settings.getChosenRulesForDomain(""));
        });
        it("should return an empty array if whitelistNoTLD = true and domain contains no dot", () => {
            settings.set("rules", [catchAllRuleNever]);
            settings.set("whitelistNoTLD", true);
            settings.set("whitelistFileSystem", false);
            assert.isEmpty(settings.getChosenRulesForDomain("hello"));
            assert.sameMembers(settings.getChosenRulesForDomain("google.com"), [catchAllRuleNever]);
            assert.sameMembers(settings.getChosenRulesForDomain(""), [catchAllRuleNever]);
        });
        it("should return the chosen rule", () => {
            settings.set("whitelistNoTLD", false);
            settings.set("whitelistFileSystem", false);
            settings.set("rules", []);
            assert.isEmpty(settings.getChosenRulesForDomain("google.com"));
            settings.set("rules", [catchAllRuleStartup]);
            assert.sameMembers(settings.getChosenRulesForDomain("google.com"), [catchAllRuleStartup]);
            settings.set("rules", [catchAllRuleStartup, catchAllRuleNever]);
            assert.sameMembers(settings.getChosenRulesForDomain("google.com"), [catchAllRuleNever]);
            settings.set("rules", [catchAllRuleStartup, catchAllRuleNever, catchAllRuleLeave]);
            assert.sameMembers(settings.getChosenRulesForDomain("google.com"), [catchAllRuleLeave]);
            settings.set("rules", [catchAllRuleStartup, catchAllRuleNever, catchAllRuleLeave, catchAllRuleInstantly]);
            assert.sameMembers(settings.getChosenRulesForDomain("google.com"), [catchAllRuleInstantly]);
            settings.set("rules", [catchAllRuleInstantly, catchAllRuleLeave, catchAllRuleNever, catchAllRuleStartup]);
            assert.sameMembers(settings.getChosenRulesForDomain("google.com"), [catchAllRuleInstantly]);
        });
        it("should return multiple chosen rules", () => {
            settings.set("whitelistNoTLD", false);
            settings.set("whitelistFileSystem", false);
            settings.set("rules", [catchAllRuleStartup, catchComRuleStartup]);
            assert.sameMembers(settings.getChosenRulesForDomain("google.com"), [catchAllRuleStartup, catchComRuleStartup]);
        });
    });

    describe("getCleanupTypeForCookie", () => {
        it("should return the default rule if no rule matches", () => {
            settings.set("rules", [
                { rule: "hello@google.com", type: CleanupType.NEVER },
                { rule: "hello@google.de", type: CleanupType.NEVER },
                { rule: "hello@google.co.uk", type: CleanupType.NEVER },
                { rule: "hello@google.jp", type: CleanupType.NEVER }
            ]);
            settings.save();
            assert.strictEqual(settings.getCleanupTypeForCookie("google.ca", "hello"), CleanupType.LEAVE);
            assert.strictEqual(settings.getCleanupTypeForCookie("google.com", "world"), CleanupType.LEAVE);
        });
        it("should return the matching domain rule if no cookie rule matches", () => {
            settings.set("rules", [
                { rule: "hello@google.com", type: CleanupType.NEVER },
                { rule: "google.com", type: CleanupType.INSTANTLY }
            ]);
            settings.save();
            assert.strictEqual(settings.getCleanupTypeForCookie("google.com", "world"), CleanupType.INSTANTLY);
        });
        it("should return the matching cookie rule even if a domain rule matches", () => {
            settings.set("rules", [
                { rule: "hello@google.com", type: CleanupType.NEVER },
                { rule: "google.com", type: CleanupType.INSTANTLY }
            ]);
            settings.save();
            assert.strictEqual(settings.getCleanupTypeForCookie("google.com", "hello"), CleanupType.NEVER);
        });
        it("should return the correct rule if a rule matches", () => {
            settings.set("rules", [
                { rule: "hello@google.com", type: CleanupType.NEVER },
                { rule: "hello@google.de", type: CleanupType.STARTUP },
                { rule: "hello@google.co.uk", type: CleanupType.LEAVE },
                { rule: "hello@google.jp", type: CleanupType.INSTANTLY }
            ]);
            settings.save();
            assert.strictEqual(settings.getCleanupTypeForCookie("google.com", "hello"), CleanupType.NEVER);
            assert.strictEqual(settings.getCleanupTypeForCookie("google.de", "hello"), CleanupType.STARTUP);
            assert.strictEqual(settings.getCleanupTypeForCookie("google.co.uk", "hello"), CleanupType.LEAVE);
            assert.strictEqual(settings.getCleanupTypeForCookie("google.jp", "hello"), CleanupType.INSTANTLY);
        });
        it("should respect the order of matching rules", () => {
            assert.strictEqual(settings.getCleanupTypeForCookie("google.com", "hello"), CleanupType.LEAVE);
            const rules: RuleDefinition[] = [];
            function addAndTest(type: CleanupType) {
                rules.push({ rule: "hello@google.com", type });
                settings.set("rules", rules);
                assert.strictEqual(settings.getCleanupTypeForCookie("google.com", "hello"), type);
            }
            addAndTest(CleanupType.STARTUP);
            addAndTest(CleanupType.NEVER);
            addAndTest(CleanupType.LEAVE);
            addAndTest(CleanupType.INSTANTLY);
        });
        it("should return NEVER for TLD-less domains if whitelistNoTLD is set", () => {
            assert.strictEqual(settings.getCleanupTypeForCookie("localmachine", "hello"), CleanupType.LEAVE);
            settings.set("whitelistNoTLD", true);
            assert.strictEqual(settings.getCleanupTypeForCookie("localmachine", "hello"), CleanupType.NEVER);
            settings.set("rules", [{ rule: "hello@localmachine", type: CleanupType.INSTANTLY }]);
            assert.strictEqual(settings.getCleanupTypeForCookie("localmachine", "hello"), CleanupType.NEVER);
            settings.set("whitelistFileSystem", false);
            assert.strictEqual(settings.getCleanupTypeForCookie("", "hello"), CleanupType.LEAVE);
        });
        it("should return NEVER for empty domains if whitelistFileSystem is set", () => {
            assert.strictEqual(settings.getCleanupTypeForCookie("", "hello"), CleanupType.NEVER);
            settings.set("whitelistFileSystem", false);
            assert.strictEqual(settings.getCleanupTypeForCookie("", "hello"), CleanupType.LEAVE);
        });
    });

    describe("getExactCleanupType", () => {
        it("should return exact matches only", () => {
            settings.set("rules", [
                { rule: "google.com", type: CleanupType.NEVER },
                { rule: "www.google.com", type: CleanupType.STARTUP },
                { rule: "mail.google.com", type: CleanupType.LEAVE },
                { rule: "*.google.com", type: CleanupType.INSTANTLY }
            ]);
            settings.save();
            assert.equal(settings.getExactCleanupType("google.com"), CleanupType.NEVER);
            assert.equal(settings.getExactCleanupType("www.google.com"), CleanupType.STARTUP);
            assert.equal(settings.getExactCleanupType("mail.google.com"), CleanupType.LEAVE);
            assert.equal(settings.getExactCleanupType("*.google.com"), CleanupType.INSTANTLY);
            assert.isNull(settings.getExactCleanupType("images.google.com"));
        });
    });

    describe("hasBlockingRule", () => {
        it("should return true if at least one blocking rule exists", () => {
            settings.set("rules", [
                { rule: "google.com", type: CleanupType.NEVER },
                { rule: "google.de", type: CleanupType.STARTUP },
                { rule: "google.co.uk", type: CleanupType.LEAVE },
                { rule: "google.jp", type: CleanupType.INSTANTLY }
            ]);
            settings.save();
            assert.isTrue(settings.hasBlockingRule());
        });
        it("should return true if the fallback rule is blocking", () => {
            settings.set("fallbackRule", CleanupType.INSTANTLY);
            settings.save();
            assert.isTrue(settings.hasBlockingRule());
        });
        it("should return false if neither the fallback rule nor any other rule is blocking", () => {
            settings.set("fallbackRule", CleanupType.LEAVE);
            settings.set("rules", [
                { rule: "google.com", type: CleanupType.NEVER },
                { rule: "google.de", type: CleanupType.STARTUP },
                { rule: "google.co.uk", type: CleanupType.LEAVE }
            ]);
            settings.save();
            assert.isFalse(settings.hasBlockingRule());
        });
        it("should return false for default settings (fallback rule = leave, no rules)", () => {
            assert.isFalse(settings.hasBlockingRule());
        });
    });

    describe("getMatchingRules", () => {
        context("without cookie name", () => {
            it("should return empty list if no rule matches", () => {
                settings.set("rules", [{ rule: "google.com", type: CleanupType.NEVER }]);
                assert.deepEqual(settings.getMatchingRules("google.de"), []);
            });
            it("should return matching rules for plain domains", () => {
                const domainRule = { rule: "google.com", type: CleanupType.NEVER };
                settings.set("rules", [domainRule]);
                assert.deepEqual(settings.getMatchingRules("google.com"), [domainRule]);
            });
            it("should not return rules for plain domains if a subdomain was given", () => {
                const domainRule = { rule: "google.com", type: CleanupType.NEVER };
                settings.set("rules", [domainRule]);
                assert.deepEqual(settings.getMatchingRules("www.google.com"), []);
            });
            it("should return rules for wildcard domains", () => {
                const domainRule1 = { rule: "*.google.com", type: CleanupType.NEVER };
                const domainRule2 = { rule: "*.amazon.*", type: CleanupType.NEVER };
                settings.set("rules", [domainRule1, domainRule2]);
                assert.deepEqual(settings.getMatchingRules("google.com"), [domainRule1]);
                assert.deepEqual(settings.getMatchingRules("www.google.com"), [domainRule1]);
                assert.deepEqual(settings.getMatchingRules("let.me.google.that.for.you.google.com"), [domainRule1]);
                assert.deepEqual(settings.getMatchingRules("amazon.de"), [domainRule2]);
                assert.deepEqual(settings.getMatchingRules("amazon.com"), [domainRule2]);
                assert.deepEqual(settings.getMatchingRules("prime.amazon.jp"), [domainRule2]);
            });
        });
        context("with cookie name", () => {
            it("should return empty list if no rule matches", () => {
                settings.set("rules", [{ rule: "hello@google.com", type: CleanupType.NEVER }]);
                assert.deepEqual(settings.getMatchingRules("google.de", "hello"), []);
                assert.deepEqual(settings.getMatchingRules("google.com", "world"), []);
            });
            it("should return matching rules for plain domains", () => {
                const domainRule = { rule: "hello@google.com", type: CleanupType.NEVER };
                settings.set("rules", [domainRule]);
                assert.deepEqual(settings.getMatchingRules("google.com", "hello"), [domainRule]);
            });
            it("should not return rules for plain domains if a subdomain was given", () => {
                const domainRule = { rule: "hello@google.com", type: CleanupType.NEVER };
                settings.set("rules", [domainRule]);
                assert.deepEqual(settings.getMatchingRules("www.google.com", "hello"), []);
            });
            it("should return rules for wildcard domains", () => {
                const domainRule1 = { rule: "hello@*.google.com", type: CleanupType.NEVER };
                const domainRule2 = { rule: "hello@*.amazon.*", type: CleanupType.NEVER };
                settings.set("rules", [domainRule1, domainRule2]);
                assert.deepEqual(settings.getMatchingRules("google.com", "hello"), [domainRule1]);
                assert.deepEqual(settings.getMatchingRules("www.google.com", "hello"), [domainRule1]);
                assert.deepEqual(settings.getMatchingRules("let.me.google.that.for.you.google.com", "hello"), [domainRule1]);
                assert.deepEqual(settings.getMatchingRules("amazon.de", "hello"), [domainRule2]);
                assert.deepEqual(settings.getMatchingRules("amazon.com", "hello"), [domainRule2]);
                assert.deepEqual(settings.getMatchingRules("prime.amazon.jp", "hello"), [domainRule2]);
            });
        });
    });

    describe("setRule", () => {
        it("should save rules", () => {
            const onChangedSpy = createSpy();
            browser.storage.onChanged.addListener(onChangedSpy);
            settings.setRule("*.com", CleanupType.INSTANTLY);
            onChangedSpy.assertCalls([[{ rules: { newValue: [{ rule: "*.com", type: CleanupType.INSTANTLY }] } }, "local"]]);
            assert.deepEqual(settings.get("rules"), [{ rule: "*.com", type: CleanupType.INSTANTLY }]);
        });
        it("should override existing rules", () => {
            settings.setRule("*.com", CleanupType.NEVER);
            settings.setRule("*.de", CleanupType.NEVER);
            const onChangedSpy = createSpy();
            browser.storage.onChanged.addListener(onChangedSpy);
            settings.setRule("*.com", CleanupType.INSTANTLY);
            onChangedSpy.assertCalls([
                [{ rules: {
                    newValue: [{ rule: "*.com", type: CleanupType.INSTANTLY }, { rule: "*.de", type: CleanupType.NEVER }],
                    oldValue: [{ rule: "*.com", type: CleanupType.NEVER }, { rule: "*.de", type: CleanupType.NEVER }]
                } }, "local"]
            ]);
            assert.deepEqual(settings.get("rules"), [{ rule: "*.com", type: CleanupType.INSTANTLY }, { rule: "*.de", type: CleanupType.NEVER }]);
        });
    });

    describe("removeRule", () => {
        it("should save rules", () => {
            settings.setRule("*.com", CleanupType.INSTANTLY);
            const onChangedSpy = createSpy();
            browser.storage.onChanged.addListener(onChangedSpy);
            settings.removeRule("*.com");
            onChangedSpy.assertCalls([[{ rules: { newValue: [], oldValue: [{ rule: "*.com", type: CleanupType.INSTANTLY }] } }, "local"]]);
            assert.deepEqual(settings.get("rules"), []);
        });
        it("should keep other rules", () => {
            settings.setRule("*.com", CleanupType.INSTANTLY);
            settings.setRule("*.de", CleanupType.NEVER);
            const onChangedSpy = createSpy();
            browser.storage.onChanged.addListener(onChangedSpy);
            settings.removeRule("*.com");
            onChangedSpy.assertCalls([[{ rules: { newValue: [{ rule: "*.de", type: CleanupType.NEVER }], oldValue: [{ rule: "*.com", type: CleanupType.INSTANTLY }, { rule: "*.de", type: CleanupType.NEVER }] } }, "local"]]);
            assert.deepEqual(settings.get("rules"), [{ rule: "*.de", type: CleanupType.NEVER }]);
        });
    });
});
