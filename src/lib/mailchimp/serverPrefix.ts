/**
 * A Mailchimp data centre, such as "us21": the part of the API host before
 * ".api.mailchimp.com". The API key goes to that host, so anything else (a full host,
 * a "/" or a "#") could send the key to another server. A server prefix is checked
 * before it is saved, and again before any call uses it.
 */
const DATA_CENTRE = /^[a-z]{2,4}\d{1,3}$/i;

export function isMailchimpServerPrefix(value: string | null | undefined): value is string {
  return typeof value === "string" && DATA_CENTRE.test(value);
}
