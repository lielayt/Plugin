const EMBY_SERVER = "https://play.embyil.tv:443";
const PROVIDER_ID = "Emby";
const CREDENTIALS_GIST_RAW_URL = "https://gist.githubusercontent.com/lielayt/01e8aec73350f3d7b35469d69eb15dc6/raw";
const CREDENTIALS_OWNER_LABEL = "Liel";
let cachedCredentialsPromise = null;

function getStreams(tmdbId, mediaType, season, episode) {
    const seasonNum = toNumberOrNull(season);
    const episodeNum = toNumberOrNull(episode);
    const media = String(mediaType || "").toLowerCase();
    const isTv = media === "tv" || media === "series" || media === "show" || (seasonNum != null && episodeNum != null);

    console.log(`[${PROVIDER_ID}] request tmdb=${tmdbId} mediaType=${mediaType} season=${season} episode=${episode}`);

    return getCredentials()
        .then(credentials => login(credentials))
        .then(auth => {
            const token = auth.accessToken;
            const userId = auth.userId;
            if (isTv) {
                return findSeriesByTmdb(token, userId, tmdbId)
                    .then(series => {
                        if (!series || seasonNum == null || episodeNum == null) {
                            console.log(`[${PROVIDER_ID}] no series or missing season/episode`);
                            return [];
                        }
                        return findEpisode(token, userId, series.Id, seasonNum, episodeNum)
                            .then(ep => {
                                if (!ep) {
                                    console.log(`[${PROVIDER_ID}] episode not found for S${seasonNum}E${episodeNum}`);
                                    return [];
                                }
                                return toStream(ep, token, userId).then(stream => [stream]);
                            });
                    });
            }

            return findMovieByTmdb(token, userId, tmdbId)
                .then(movie => {
                    if (!movie) {
                        console.log(`[${PROVIDER_ID}] movie not found`);
                        return [];
                    }
                    return toStream(movie, token, userId).then(stream => [stream]);
                });
        })
        .catch(err => {
            console.error(`[${PROVIDER_ID}] error: ${err && err.message ? err.message : String(err)}`);
            return [];
        });
}

function getCredentials() {
    if (!cachedCredentialsPromise) {
        cachedCredentialsPromise = fetch(CREDENTIALS_GIST_RAW_URL)
            .then(readText)
            .then(parseCredentialsFromGistText);
    }
    return cachedCredentialsPromise;
}

function parseCredentialsFromGistText(text) {
    const cleaned = String(text || "").replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "");
    const lines = cleaned
        .split(/\r?\n/)
        .map(line => String(line || "").trim())
        .filter(Boolean);

    const ownerIndex = lines.findIndex(line => line.toLowerCase() === CREDENTIALS_OWNER_LABEL.toLowerCase());
    if (ownerIndex === -1 || !lines[ownerIndex + 1] || !lines[ownerIndex + 2]) {
        throw new Error(`Credentials for "${CREDENTIALS_OWNER_LABEL}" not found in gist`);
    }

    return {
        username: lines[ownerIndex + 1],
        password: lines[ownerIndex + 2]
    };
}

function login(credentials) {
    const headers = {
        "Content-Type": "application/json",
        "X-Emby-Authorization": 'Emby Client="EmbyWeb", Device="Android TV", DeviceId="androidtv-1234", Version="1.0.0"'
    };

    return fetch(`${EMBY_SERVER}/Users/AuthenticateByName`, {
        method: "POST",
        headers,
        body: JSON.stringify({ Username: credentials.username, Pw: credentials.password })
    })
        .then(readJson)
        .then(data => {
            if (!data.AccessToken) throw new Error("No AccessToken returned");
            const userId = (data.User && data.User.Id) || data.UserId || (data.SessionInfo && data.SessionInfo.UserId);
            if (!userId) throw new Error("No UserId returned");
            return { accessToken: data.AccessToken, userId };
        });
}

function findMovieByTmdb(token, userId, tmdbId) {
    const url = `${EMBY_SERVER}/Users/${userId}/Items?AnyProviderIdEquals=Tmdb.${encodeURIComponent(tmdbId)}&IncludeItemTypes=Movie&Recursive=true&Limit=1&api_key=${token}`;
    return fetch(url)
        .then(readJson)
        .then(data => data.Items && data.Items[0]);
}

function findSeriesByTmdb(token, userId, tmdbId) {
    const url = `${EMBY_SERVER}/Users/${userId}/Items?AnyProviderIdEquals=Tmdb.${encodeURIComponent(tmdbId)}&IncludeItemTypes=Series&Recursive=true&Limit=1&api_key=${token}`;
    return fetch(url)
        .then(readJson)
        .then(data => data.Items && data.Items[0]);
}

function findEpisode(token, userId, seriesId, seasonNum, episodeNum) {
    const url = `${EMBY_SERVER}/Shows/${seriesId}/Episodes?UserId=${userId}&Season=${seasonNum}&api_key=${token}`;
    return fetch(url)
        .then(readJson)
        .then(data => {
            if (!data.Items || !data.Items.length) return null;
            return data.Items.find(item => Number(item.IndexNumber) === episodeNum) || null;
        });
}

function toStream(item, token, userId) {
    return getSubtitles(token, userId, item.Id).then(subtitles => ({
        name: PROVIDER_ID,
        title: item.Name || "Emby Stream",
        url: `${EMBY_SERVER}/Videos/${item.Id}/stream?static=true&api_key=${token}`,
        quality: "Auto",
        provider: PROVIDER_ID,
        subtitles
    }));
}

function getSubtitles(token, userId, itemId) {
    const url = `${EMBY_SERVER}/Items/${itemId}/PlaybackInfo?UserId=${userId}&api_key=${token}`;
    return fetch(url, { method: "POST" })
        .then(readJson)
        .then(data => buildSubtitleTracks(itemId, token, data))
        .catch(() => []);
}

function buildSubtitleTracks(itemId, token, playbackInfo) {
    const tracks = [];
    const mediaSources = Array.isArray(playbackInfo && playbackInfo.MediaSources) ? playbackInfo.MediaSources : [];

    mediaSources.forEach(source => {
        const streams = Array.isArray(source.MediaStreams) ? source.MediaStreams : [];
        streams
            .filter(s => s && s.Type === "Subtitle")
            .forEach(s => {
                const index = Number(s.Index);
                if (!Number.isFinite(index)) return;

                const rawLanguage = getRawLanguageCode(s.Language, s.DisplayTitle);
                const normalizedLanguage = normalizeLanguage(rawLanguage, s.DisplayTitle);
                let subUrl = null;
                if (s.DeliveryUrl) {
                    subUrl = `${EMBY_SERVER}${s.DeliveryUrl}`;
                    if (subUrl.indexOf("api_key=") === -1) {
                        subUrl += (subUrl.indexOf("?") === -1 ? "?" : "&") + `api_key=${token}`;
                    }
                } else if (source.Id) {
                    const codec = (s.Codec || "srt").toLowerCase();
                    subUrl = `${EMBY_SERVER}/Videos/${itemId}/${source.Id}/Subtitles/${index}/Stream.${codec}?api_key=${token}`;
                }

                if (!subUrl) return;
                tracks.push({
                    lang: normalizedLanguage,
                    language: rawLanguage,
                    label: s.DisplayTitle || s.DisplayLanguage || (normalizedLanguage === "heb" ? "Hebrew" : normalizedLanguage.toUpperCase()),
                    url: subUrl
                });
            });
    });

    // Deduplicate by URL.
    const seen = new Set();
    const deduped = [];
    for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (seen.has(t.url)) continue;
        seen.add(t.url);
        deduped.push(t);
    }
    return deduped;
}

function getRawLanguageCode(lang, title) {
    if (lang && String(lang).trim()) return String(lang).toLowerCase();
    const raw = String(title || "").toLowerCase();
    if (raw.includes("hebrew") || raw.includes("heb")) return "he";
    return "und";
}

function normalizeLanguage(lang, title) {
    const raw = `${lang || ""} ${title || ""}`.toLowerCase();
    if (raw.includes("hebrew") || raw.includes("heb") || raw === "he" || raw.includes(" he ")) {
        return "heb";
    }
    if (!lang) return "und";
    return String(lang).toLowerCase();
}

function toNumberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function readJson(res) {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

function readText(res) {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

// Export for Nuvio
if (typeof module !== "undefined") module.exports = { getStreams };
