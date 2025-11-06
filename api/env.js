export default async function handler(req, res) {
  const url = process.env.KV2_REST_API_URL || "";
  const token = !!process.env.KV2_REST_API_TOKEN;
  const hash = [...url].reduce((h,c)=>((h*31+c.charCodeAt(0))>>>0),0).toString(16);
  res.status(200).json({ kv_url_present: !!url, kv_token_present: token, kv_url_hash: hash });
}
