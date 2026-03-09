const { getStreams } = require('./providers/emby.js');

// Replace '872585' with a TMDB ID you verified exists in your Emby server
getStreams('290353', 'tv', 3, 6).then(streams => {
    console.log('Streams found:', streams);
});
