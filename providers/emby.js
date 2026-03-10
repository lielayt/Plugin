const EMBY_SERVER = "https://play.embyil.tv:443";
const PROVIDER_ID = "emby";
const PROVIDER_NAME = "Emby";
const CREDENTIALS_GIST_RAW_URL = "https://gist.githubusercontent.com/lielayt/01e8aec73350f3d7b35469d69eb15dc6/raw";
const CREDENTIALS_OWNER_LABEL = "Liel";
const TM = "36fb162e5c4e8f206515ddf92070d434"
let cachedCredentialsPromise = null;

function getStreams(tmdbId, mediaType, season, episode) {
    const seasonNum = toNumberOrNull(season);
    const episodeNum = toNumberOrNull(episode);
    const media = String(mediaType || "").toLowerCase();
    const isTv = media === "tv" || media === "series" || media === "show" || (seasonNum != null && episodeNum != null);

    console.log(`[${PROVIDER_NAME}] request tmdb=${tmdbId} mediaType=${mediaType} season=${season} episode=${episode}`);

    return getCredentials()
        .then(credentials => login(credentials))
        .then(auth => {
            const token = auth.accessToken;
            const userId = auth.userId;
            if (isTv) {
                return findSeriesByTmdb(token, userId, tmdbId)
                    .then(series => {

                        if (!series) {
                            console.log(`[${PROVIDER_NAME}] TMDB match failed, trying name search`);

                            return getTmdbTitle(tmdbId, "tv")
                                .then(name => {
                                    if (!name) return null;
                                    return searchByName(token, name);
                                });
                        }

                        return series;
                    })
                    .then(series => {
                        if (!series || seasonNum == null || episodeNum == null) {
                            return [];
                        }

                        return findEpisode(token, userId, series.Id, seasonNum, episodeNum)
                            .then(ep => {
                                console.log(ep)
                                if (!ep) return [];
                                return toStream(ep, token, userId).then(stream => [stream]);
                            });
                    });
            }

            return findMovieByTmdb(token, userId, tmdbId)
                .then(movie => {
                    if (movie) {
                        return toStream(movie, token, userId).then(stream => [stream]);
                    }

                    console.log(`[${PROVIDER_NAME}] TMDB match failed, trying name search`);

                    return getTmdbTitle(tmdbId, "movie")
                        .then(name => {
                            if (!name) return [];

                            return searchByName(token, name);
                        })
                        .then(result => {
                            if (!result) return [];
                            return toStream(result, token).then(stream => [stream]);
                        });
                });
        })
        .catch(err => {
            console.error(`[${PROVIDER_NAME}] error: ${err && err.message ? err.message : String(err)}`);
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
    return getPlaybackInfo(item.Id, token, userId)
        .then(info => {
            const quality = info && info.width && info.height ? `${info.height}p` : "Auto";

            return {
                name: PROVIDER_NAME,
                title: item.Name || "Emby Stream",
                url: `${EMBY_SERVER}/Videos/${item.Id}/stream?static=true&api_key=${token}`,
                quality,
                provider: PROVIDER_ID,
                logo: "https://raw.githubusercontent.com/lielayt/plugin/main/Assets/emby.png"
            };
        });
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

function searchByName(token, name) {
    const url = `${EMBY_SERVER}/emby/Items?SearchTerm=${encodeURIComponent(name)}&IncludeItemTypes=Movie,Series&Recursive=true&Limit=20&api_key=${token}`;

    return fetch(url)
        .then(readJson)
        .then(data => { data.Items && data.Items[0]});
}

function getTmdbTitle(tmdbId, mediaType) {
    const type = mediaType === "movie" ? "movie" : "tv";

    const url = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TM}&language=he-IL`;

    return fetch(url)
        .then(readJson)
        .then(data => {
            return type === "movie" ? data.title : data.name;
        })
        .catch(() => null);
}

function getPlaybackInfo(itemId, token, userId) {
    const url = `${EMBY_SERVER}/emby/Items/${itemId}/PlaybackInfo` +
                `?UserId=${userId}&StartTimeTicks=0&IsPlayback=false&AutoOpenLiveStream=false` +
                `&X-Emby-Client=EmbyWeb&X-Emby-Device-Name=NodeJS&X-Emby-Device-Id=nodejs-1234` +
                `&X-Emby-Client-Version=1.0.0&X-Emby-Token=${token}&reqformat=json`;

    return fetch(url)
        .then(readJson)
        .then(data => {
            if (!data || !data.MediaSources || !data.MediaSources.length) return null;

            const source = data.MediaSources[0];
            return {
                width: source.MediaStreams[0].Width || 0,
                height: source.MediaStreams[0].Height || 0,
                bitrate: source.Bitrate || 0
            };
        })
        .catch(() => null);
}


// Export for Nuvio
if (typeof module !== "undefined" && module.exports) module.exports = { getStreams };
if (typeof exports !== "undefined") exports.getStreams = getStreams;
if (typeof globalThis !== "undefined") globalThis.getStreams = getStreams;