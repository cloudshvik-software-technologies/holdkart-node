export const success = (res, data, code = 200) => res.status(code).json(data);
  export const error   = (res, message, code = 500) => res.status(code).json({ message });
  