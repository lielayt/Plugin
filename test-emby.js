const { getStreams } = require('./providers/emby.js');

// Replace '872585' with a TMDB ID you verified exists in your Emby server
getStreams('2316', 'tv', 9, 6).then(streams => {
    console.log('Streams found:', streams);
});
