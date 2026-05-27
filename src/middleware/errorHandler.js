export const notFound = (req, res) => {
    res.status(404).json({ message: `Route ${req.method} ${req.url} not found` });
  };

  export const errorHandler = (err, req, res, _next) => {
    console.error('[ERROR]', err.message);
    res.status(err.status || 500).json({ message: err.message || 'Internal server error' });
  };
  