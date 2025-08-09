// CommonJS ping – slúži len na overenie routingu
/** @type {(req: import('@vercel/node').VercelRequest, res: import('@vercel/node').VercelResponse) => Promise<void>} */
module.exports = async function handler(req, res) {
  res.status(200).json({ ok: true, time: new Date().toISOString() });
};
