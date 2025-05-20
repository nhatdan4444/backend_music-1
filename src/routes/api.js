const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const Favorite = require('../models/favorite');
const Downloaded = require('../models/downloaded');
const Playlist = require('../models/playlist');
const axios = require('axios');

// Mô hình ánh xạ Spotify sang YouTube
const Mapping = require('../models/mapping');

// Tìm kiếm video YouTube
router.get('/youtube/search', authMiddleware, async (req, res) => {
  try {
    const { query, maxResults = 5 } = req.query;
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // Gọi YouTube Data API v3
    const youtubeResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        q: query,
        type: 'video',
        maxResults: parseInt(maxResults),
        key: process.env.YOUTUBE_API_KEY,
      },
    });

    const videos = youtubeResponse.data.items.map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      thumbnail: item.snippet.thumbnails.default.url,
    }));

    if (videos.length === 0) {
      return res.status(404).json({ error: 'No videos found' });
    }

    res.json(videos);
  } catch (error) {
    console.error('Error in /youtube/search:', error);
    res.status(500).json({ error: 'Failed to search YouTube: ' + error.message });
  }
});
// Tìm kiếm bài hát từ Spotify và ánh xạ sang YouTube
router.get('/spotify/search', authMiddleware, async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // Gọi Spotify API để tìm kiếm
    const spotifyToken = await getSpotifyAccessToken();
    const spotifyResponse = await axios.get('https://api.spotify.com/v1/search', {
      params: {
        q: query,
        type: 'track',
        limit: 10,
        offset: 0,
      },
      headers: { Authorization: `Bearer ${spotifyToken}` },
    });

    const tracks = spotifyResponse.data.tracks.items;
    if (!tracks || tracks.length === 0) {
      return res.status(404).json({ error: 'No tracks found' });
    }

    // Ánh xạ từng track sang YouTube video ID
    const songs = await Promise.all(
      tracks.map(async (track) => {
        const trackId = track.id;
        const searchQuery = `${track.name} ${track.artists.map((a) => a.name).join(' ')}`;
        let youtubeVideoId = await getYouTubeVideoId(trackId, searchQuery);

        // Nếu không tìm thấy ánh xạ, lưu mới vào cơ sở dữ liệu
        if (!youtubeVideoId) {
          const youtubeResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: {
              part: 'snippet',
              q: searchQuery,
              type: 'video',
              maxResults: 1,
              key: process.env.YOUTUBE_API_KEY,
            },
          });
          const video = youtubeResponse.data.items[0];
          if (video) {
            youtubeVideoId = video.id.videoId;
            await new Mapping({ spotify_track_id: trackId, youtube_video_id: youtubeVideoId }).save();
          }
        }

        return {
          id: youtubeVideoId || '',
          title: track.name,
          artist: track.artists.map((a) => a.name).join(', '),
          album: track.album.name,
          imageUrl: track.album.images[0]?.url || '',
          thumbnail: track.album.images[2]?.url || '',
        };
      }),
    );

    res.json(songs);
  } catch (error) {
    console.error('Error in /spotify/search:', error);
    res.status(500).json({ error: 'Failed to search Spotify: ' + error.message });
  }
});

// Lấy access token của Spotify (Client Credentials Flow)
async function getSpotifyAccessToken() {
  const credentials = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    'grant_type=client_credentials',
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    },
  );
  return response.data.access_token;
}

// Lấy YouTube video ID từ cơ sở dữ liệu ánh xạ
async function getYouTubeVideoId(spotifyTrackId, query) {
  const mapping = await Mapping.findOne({ spotify_track_id: spotifyTrackId });
  return mapping ? mapping.youtube_video_id : null;
}

// Thêm bài hát vào danh sách yêu thích
router.post('/favorites', authMiddleware, async (req, res) => {
  try {
    const { song } = req.body;
    if (!song || !song.id) {
      return res.status(400).json({ error: 'Song data or ID is required' });
    }
    const favorite = new Favorite({ userId: req.user.userId, song });
    await favorite.save();
    res.status(201).json(favorite);
  } catch (error) {
    console.error('Error in /favorites:', error);
    res.status(500).json({ error: 'Failed to save favorite' });
  }
});

// Lấy danh sách yêu thích
router.get('/favorites', authMiddleware, async (req, res) => {
  try {
    const favorites = await Favorite.find({ userId: req.user.userId });
    res.json(favorites);
  } catch (error) {
    console.error('Error in /favorites:', error);
    res.status(500).json({ error: 'Failed to fetch favorites' });
  }
});

// Thêm bài hát đã tải
router.post('/downloaded', authMiddleware, async (req, res) => {
  try {
    const { fileName, song } = req.body;
    if (!fileName || !song || !song.id) {
      return res.status(400).json({ error: 'File name and song data are required' });
    }
    const downloaded = new Downloaded({ userId: req.user.userId, fileName, song });
    await downloaded.save();
    res.status(201).json(downloaded);
  } catch (error) {
    console.error('Error in /downloaded:', error);
    res.status(500).json({ error: 'Failed to save downloaded song' });
  }
});

// Lấy danh sách bài hát đã tải
router.get('/downloaded', authMiddleware, async (req, res) => {
  try {
    const downloaded = await Downloaded.find({ userId: req.user.userId });
    res.json(downloaded);
  } catch (error) {
    console.error('Error in /downloaded:', error);
    res.status(500).json({ error: 'Failed to fetch downloaded songs' });
  }
});

// Xóa bài hát khỏi danh sách yêu thích
router.delete('/favorites/:id', authMiddleware, async (req, res) => {
  try {
    const favorite = await Favorite.findOneAndDelete({ _id: req.params.id, userId: req.user.userId });
    if (!favorite) {
      return res.status(404).json({ error: 'Favorite not found' });
    }
    res.json({ message: 'Favorite deleted' });
  } catch (error) {
    console.error('Error in /favorites/:id:', error);
    res.status(500).json({ error: 'Failed to delete favorite' });
  }
});

// Tạo playlist
router.post('/playlists', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Playlist name is required' });
    }
    const playlist = new Playlist({ userId: req.user.userId, name, songs: [] });
    await playlist.save();
    res.status(201).json(playlist);
  } catch (error) {
    console.error('Error in /playlists:', error);
    res.status(500).json({ error: 'Failed to create playlist' });
  }
});

// Lấy danh sách playlists
router.get('/playlists', authMiddleware, async (req, res) => {
  try {
    const playlists = await Playlist.find({ userId: req.user.userId });
    res.json(playlists);
  } catch (error) {
    console.error('Error in /playlists:', error);
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

// Thêm bài hát vào playlist
router.post('/playlists/:id/songs', authMiddleware, async (req, res) => {
  try {
    const { song } = req.body;
    if (!song || !song.id) {
      return res.status(400).json({ error: 'Song data is required' });
    }
    const playlist = await Playlist.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }
    playlist.songs.push(song);
    await playlist.save();
    res.json(playlist);
  } catch (error) {
    console.error('Error in /playlists/:id/songs:', error);
    res.status(500).json({ error: 'Failed to add song to playlist' });
  }
});

// Xóa playlist
router.delete('/playlists/:id', authMiddleware, async (req, res) => {
  try {
    const playlist = await Playlist.findOneAndDelete({ _id: req.params.id, userId: req.user.userId });
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }
    res.status(200).json({ message: 'Playlist deleted' });
  } catch (error) {
    console.error('Delete playlist error:', error);
    res.status(500).json({ error: 'Failed to delete playlist' });
  }
});

module.exports = router;
