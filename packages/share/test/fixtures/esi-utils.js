// expo-share-intent 8.0.1 build/utils.js:37-120 (parseJson, parseShareIntent), copied verbatim so the hook tests run
// upstream's real parser without its expo-constants and expo-linking imports. SHAREINTENT_DEFAULTVALUE is
// build/useShareIntent.js:6-11. Upstream's license:
/*
 * MIT License
 *
 * Copyright (c) 2023 Evan Bacon
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const SHAREINTENT_DEFAULTVALUE = {
    files: null,
    text: null,
    webUrl: null,
    type: null,
};
export function parseJson(value, defaultValue = null) {
    try {
        return JSON.parse(value);
    }
    catch (e) {
        console.debug(e);
        return defaultValue;
    }
}
export const parseShareIntent = (value, options) => {
    let result = SHAREINTENT_DEFAULTVALUE;
    if (!value)
        return result;
    let shareIntent;
    // ios native module send a raw string of the json, try to parse it
    if (typeof value === "string") {
        shareIntent = parseJson(value); // iOS
    }
    else {
        shareIntent = value; // Android
    }
    if (shareIntent?.text) {
        // Try to find the webURL in the SharedIntent text
        const webUrl = shareIntent.text
            .match(/[(http(s)?)://(www.)?-a-zA-Z0-9@:%._+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_+.~#?&//=]*)/gi)
            ?.find((link) => link.startsWith("http")) || null;
        result = {
            ...SHAREINTENT_DEFAULTVALUE,
            type: webUrl ? "weburl" : "text",
            text: shareIntent.text,
            webUrl,
            meta: {
                title: shareIntent.meta?.title ?? undefined,
            },
        };
    }
    else if (shareIntent?.weburls?.length) {
        const weburl = shareIntent.weburls[0];
        result = {
            ...SHAREINTENT_DEFAULTVALUE,
            type: "weburl",
            text: weburl.url, // retrocompatibility
            webUrl: weburl.url,
            meta: parseJson(weburl.meta, {}),
        };
    }
    else {
        // Ensure we got a valid file. some array value are emply
        const files = shareIntent?.files?.filter((file) => file.path || file.contentUri) ||
            [];
        const isMedia = files.every((file) => file.mimeType.startsWith("image/") ||
            file.mimeType.startsWith("video/"));
        result = {
            ...SHAREINTENT_DEFAULTVALUE,
            files: shareIntent?.files
                ? shareIntent.files.reduce((acc, file) => {
                    if (!file.path && !file.contentUri)
                        return acc;
                    return [
                        ...acc,
                        {
                            path: file.path ||
                                (file.filePath ? `file://${file.filePath}` : null) ||
                                file.contentUri ||
                                null,
                            mimeType: file.mimeType || null,
                            fileName: file.fileName || null,
                            width: file.width ? Number(file.width) : null,
                            height: file.height ? Number(file.height) : null,
                            size: file.fileSize ? Number(file.fileSize) : null,
                            duration: file.duration ? Number(file.duration) : null,
                        },
                    ];
                }, [])
                : null,
            type: isMedia ? "media" : "file",
        };
    }
    options.debug &&
        console.debug("useShareIntent[parsed] ", JSON.stringify(result, null, 2));
    return result;
};
