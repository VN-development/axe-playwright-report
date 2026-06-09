import {Locator, Page} from '@playwright/test';
import AxeBuilder from "@axe-core/playwright";
import {randomUUID} from 'crypto';
import fs from 'fs/promises';
import {RunOptions} from "axe-core";

export interface AxeScanAccessibilityConfig {
    id?: string;
    name?: string;
    options?: RunOptions | null;
    scan: boolean;
    outputDir: string;
    screenshots: boolean;
    tags: string[];
    withRules: string[];
    excludeRules: string[];
    include: string[];
    exclude: string[];
    customRegExp: RegExp[];
}

/**
 * A decorator that runs an accessibility scan using Axe after executing the decorated method.
 *
 * **Usage Instructions**:
 * 1. This decorator should be assigned to methods within a **Page Object** class.
 * 2. The Page Object class should contain a parameter of type `Page` (otherwise, the accessibility scan will not be executed).
 * 3. The accessibility scan is performed after the body of the method is executed. The method will only be executed if the accessibility scan passes.
 *
 * The scan checks for common accessibility issues using the Axe-core library.
 *
 * @template This - The type of the class instance (or object) on which the decorated method is called.
 * @template Args - The type of arguments the decorated method takes.
 * @template Return - The return type of the decorated method.
 *
 * @param decoratorConfig - A decorator configuration.
 *
 * @returns A new function that runs the accessibility scan after executing the original method.
 * It returns a `Promise` that resolves to the return value of the original method.
 *
 * @example
 *   @axeScan
 *   async someMethod() {
 *     this.page.getByText('Hello World').click();
 *   }
 */
export function axeScan<This, Args extends any[], Return>(decoratorConfig?: Partial<{
    pageProperty: string;
    accessibilityConfig: Partial<AxeScanAccessibilityConfig>;
}>) {
    return function actualDecorator(target: (this: This, ...args: Args) => Promise<Return>) {
        return async function scan(this: any, ...args: Args): Promise<Return> {
            const result = await target.apply(this, args);

            await axeScanRaw(() => {
                const page: Page = decoratorConfig?.pageProperty ? this[decoratorConfig?.pageProperty] : Object.values(this).find((prop): prop is Page => prop?.constructor?.name === 'Page');
                if (!page) {
                    console.warn(`Page not found in context in args [${Object.values(this)}].\n(Make sure you are using the decorator on a method that has access to the Playwright Page);\nSkipping axe scan.\n`);
                }
                return page;
            }, decoratorConfig?.accessibilityConfig);

            return result
        }
    }
}

export async function axeScanRaw(page: Page | (() => Page), config?: Partial<AxeScanAccessibilityConfig>): Promise<void> {
    let accessibilityConfig = await loadEnvConfigCached()
    if (config) {
        accessibilityConfig = {
            ...accessibilityConfig,
            ...config,
        };
    }

    if (accessibilityConfig.scan) {
        if (typeof page === 'function') {
            page = page();
        }
        if (!page) {
            return;
        }

        let axeBuilder = new AxeBuilder({page});

        if (accessibilityConfig.options) axeBuilder.options({...accessibilityConfig.options});
        if (accessibilityConfig.tags.length > 0) axeBuilder.withTags(accessibilityConfig.tags);
        if (accessibilityConfig.withRules.length > 0) axeBuilder.withRules(accessibilityConfig.withRules);
        if (accessibilityConfig.excludeRules.length > 0) axeBuilder.disableRules(accessibilityConfig.excludeRules);
        if (accessibilityConfig.exclude.length > 0) {
            accessibilityConfig.exclude.forEach(locator  => axeBuilder.exclude(locator));
        }
        if (accessibilityConfig.include.length > 0) {
            accessibilityConfig.include.forEach(locator  => axeBuilder.include(locator));
        }

        const accessibilityScanResults = await axeBuilder.analyze();

        const id = accessibilityConfig.id || (randomUUID() + '_' + new Date().getTime().toString().slice(-4));
        accessibilityScanResults['id'] = id;
        accessibilityScanResults['name'] = accessibilityConfig.name || id;

        const url = normalizeUrl(accessibilityScanResults.url, accessibilityConfig.customRegExp);
        const relativeUrl = url.replace(process.env.URL ?? "", "");
        accessibilityScanResults['newUrl'] = url;
        accessibilityScanResults['pagePath'] = relativeUrl;
        const violations = accessibilityScanResults.violations;
        const incomplete = accessibilityScanResults.incomplete;

        if (violations.length > 0 || incomplete.length > 0 || accessibilityScanResults.passes.length) {
            accessibilityScanResults['path'] = formatUrl(relativeUrl);
            accessibilityScanResults['violationsScreenShot'] = `${id}_violations.png`;
            accessibilityScanResults['incompleteScreenShot'] = `${id}_incomplete.png`;
            accessibilityScanResults['inapplicableScreenShot'] = `${id}_inapplicable.png`;

            await prepareDirCached(accessibilityConfig.outputDir);

            await fs.writeFile(`${accessibilityConfig.outputDir}/${accessibilityScanResults['id']}.json`, JSON.stringify(accessibilityScanResults, null, 2));

            if (accessibilityConfig.screenshots) {
                await highlightEachIssuesAndSaveScreenshot(violations, page, "red", id + "_violations", accessibilityConfig.outputDir);
                await highlightEachIssuesAndSaveScreenshot(incomplete, page, "red", id + "_incomplete", accessibilityConfig.outputDir);
            }
        }
    }
}

async function prepareDir(dirname: string): Promise<void> {
    const isExists = await fileExists(dirname);
    if (!isExists) {
        await fs.mkdir(dirname, {recursive: true});
    }
}

function formatUrl(relativeUrl: string): string {
    const path = relativeUrl.replace(/[^a-zA-Z0-9]/g, "-").replace(/^-+|-+$/g, "");
    return path.startsWith("/") ? path : `/${path}`;
}

async function highlightEachIssuesAndSaveScreenshot(issues: any[], page: Page, color: string, fileName: string, outputDir: string) {
    for (let i = 0; i < issues.length; i++) {
        for (let j = 0; j < issues[i].nodes.length; j++) {
            for (let k = 0; k < issues[i].nodes[j].target.length; k++) {
                try {
                    const element = (await page.locator(<string>issues[i].nodes[j].target[k]).all())[0]
                    await highlightElement(element, j, color);
                } catch (ignore: any) {
                }
            }
        }

        await page.screenshot({
            path: `${outputDir}/${fileName}_${i + 1}.png`,
            fullPage: true,
        });

        // Delete all highlighted elements for the current issue
        for (let j = 0; j < issues[i].nodes.length; j++) {
            for (let k = 0; k < issues[i].nodes[j].target.length; k++) {
                try {
                    const element = (await page.locator(<string>issues[i].nodes[j].target[k]).all())[0]
                    await element.evaluate((el) => {
                        el.style.outline = "none";
                        const marker = el.querySelector(`[id^="marker-"]`);
                        if (marker) {
                            marker.textContent = "";
                            marker.remove();
                        }
                    }, {timeout: 250});
                } catch (ignore: any) {
                }
            }
        }
    }
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await fs.access(path, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}


async function loadEnvConfig(envPath: string = ".env.a11y"): Promise<AxeScanAccessibilityConfig> {
    const defaultConfig = {
        scan: true,
        outputDir: "axe-playwright-report/pages",
        screenshots: false,
        tags: [] as string[],
        withRules: [] as string[],
        excludeRules: [] as string[],
        include: [] as string[],
        exclude: [] as string[],
        customRegExp: [] as RegExp[],
    };

    const envPathExists = await fileExists(envPath);

    if (!envPathExists) return defaultConfig;

    const content = await fs.readFile(envPath, "utf-8");
    const env: Record<string, string> = {};

    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        const [key, ...rest] = trimmed.split("=");
        if (!key || rest.length === 0) continue;

        env[key] = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
    }

    let regexPatterns;

    const raw = env["CUSTOM_REG_EXP"] || process.env.CUSTOM_REG_EXP!; // raw string from env
    if (raw != undefined) {
        const patternStrings = raw.slice(1, -1).split('", "').map(s => s.replace(/^"|"$/g, ''));

            regexPatterns = patternStrings.map(pattern => {
                try {
                    return new RegExp(pattern, "g"); // assumes no flags, raw pattern only
                } catch (e) {
                    throw new Error(`Invalid regex pattern: ${pattern} — ${e}`);
                }
            });
    }

    return {
        scan: env["SCAN"] ? env["SCAN"].toUpperCase() === "ON" : (process.env.SCAN ? process.env.SCAN.toUpperCase() === "ON" : defaultConfig.scan),
        outputDir: env["OUTPUT_DIR"] ? env["OUTPUT_DIR"] + "/pages" : (process.env.OUTPUT_DIR ? process.env.OUTPUT_DIR + "/pages" : defaultConfig.outputDir),
        screenshots: env["SCREENSHOT"] ? env["SCREENSHOT"].toUpperCase() === "ON" : (process.env.SCREENSHOT ? process.env.SCREENSHOT.toUpperCase() === "ON" : defaultConfig.screenshots),
        tags: env["TAGS"] ? env["TAGS"].split(",").map(t => t.trim()).filter(Boolean) : (process.env.TAGS ? process.env.TAGS.split(",").map(t => t.trim()).filter(Boolean) : defaultConfig.tags),
        withRules: env["WITH_RULES"] ? env["WITH_RULES"].split(",").map(t => t.trim()).filter(Boolean) : (process.env.WITH_RULES ? process.env.WITH_RULES.split(",").map(t => t.trim()).filter(Boolean) : defaultConfig.withRules),
        excludeRules: env["EXCLUDE_RULES"] ? env["EXCLUDE_RULES"].split(",").map(t => t.trim()).filter(Boolean) : (process.env.EXCLUDE_RULES ? process.env.EXCLUDE_RULES.split(",").map(t => t.trim()).filter(Boolean) : defaultConfig.excludeRules),
        include: env["INCLUDE"] ? env["INCLUDE"].split(",").map(t => t.trim()).filter(Boolean) : (process.env.INCLUDE ? process.env.INCLUDE.split(",").map(t => t.trim()).filter(Boolean) : defaultConfig.include),
        exclude: env["EXCLUDE"] ? env["EXCLUDE"].split(",").map(t => t.trim()).filter(Boolean) : (process.env.EXCLUDE ? process.env.EXCLUDE.split(",").map(t => t.trim()).filter(Boolean) : defaultConfig.exclude),
        customRegExp: regexPatterns
    };
}

async function highlightElement(element: Locator, index: number, color: string) {
    try {
        await element.evaluate((el, args) => {
            el.scrollIntoView({behavior: "auto", block: "center"});
            el.style.position = "relative"; // Ensure proper placement
            el.style.outline = `2px solid ${args.color}`; // Highlight border with given color

            // Create a marker div
            const marker = document.createElement("div");
            marker.id = `marker-${args.index}`;
            marker.textContent = `${args.index + 1}`; // Numbering

            // Style the marker
            marker.style.position = "absolute";
            marker.style.top = "50%"; // Start at middle
            marker.style.left = "50%"; // Start at middle
            marker.style.transform = "translate(-50%, -50%)"; // Center correctly
            marker.style.width = "22px"; // Make a square
            marker.style.height = "22px";
            marker.style.display = "flex";
            marker.style.alignItems = "center";
            marker.style.justifyContent = "center";
            marker.style.background = args.color; // Use the passed color
            marker.style.color = "white";
            marker.style.fontSize = "14px";
            marker.style.fontWeight = "bold";
            marker.style.borderRadius = "50%"; // Make it circular

            el.appendChild(marker);
        }, {index, color}, {timeout: 250});
    } catch (ignore: any) {
    }
}

function normalizeUrl(url, customPatterns: RegExp[] = []) {
    const urlObj = new URL(url, "http://dummy.base");
    let pathname = urlObj.pathname;
    let isCustomRegExp = false;

    let counter = 1; // Unique counter across all matches
    for (const pattern of customPatterns) {
        const matches = [...pathname.matchAll(pattern)];

        if (matches.length > 0) {
            for (const match of matches) {
                pathname = pathname.replace(match[0], `/{$regExp${counter++}}`);
            }
            isCustomRegExp = true;
        }
        if (!pathname.includes("/", 0))  pathname += "/";
    }
    if (isCustomRegExp) {
        return pathname + urlObj.search;
    } else {

        const normalizedPath = urlObj.pathname
            .split("/")
            .filter(Boolean)
            .map(segment => {
                if (segment.includes(".")) return segment; // e.g., inventory.html
                if (/^\d+$/.test(segment)) return ":id"; // numbers only
                if (/^(?=.*[a-zA-Z])(?=.*[0-9])[a-zA-Z0-9]{5,36}$/.test(segment)) return ":value";
                if (/^(?=.*[a-zA-Z])(?=.*[0-9])[a-zA-Z0-9-]{4,11}$/.test(segment)) return ":slug_id";
                if (/^(?=.*[a-zA-Z])(?=.*[0-9])[a-zA-Z0-9-]{12,36}$/.test(segment)) return ":uuid";
                return segment;
            })
            .join("/");

        const params = Array.from(urlObj.searchParams.entries())
            .map(([key]) => `${key}=*`)
            .sort();

        const normalizedSearch = params.length > 0 ? `?${params.join("&")}` : "";

        return "/" + normalizedPath + normalizedSearch;
    }
}

const memoizeCache = new Map();

function memoize<T extends (...args: any[]) => any>(fn: T): T {
    return ((...args: any[]) => {
        const key = JSON.stringify(args);

        if (memoizeCache.has(key)) {
            return memoizeCache.get(key);
        }

        const result = fn.apply(null, args);
        memoizeCache.set(key, result);
        return result;
    }) as T;
}

const loadEnvConfigCached = memoize(loadEnvConfig);
const prepareDirCached = memoize(prepareDir);