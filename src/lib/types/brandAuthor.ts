/**
 * An author a brand has written under (CREATE_BLOG_EDITORIAL_ENABLED): their role, the bio for
 * an article's author box and their own profile page, kept so their next article starts with
 * them filled in. One per name per brand (`brand_authors`, regional).
 */
export interface BrandAuthor {
  id: string;
  tenantId: string;
  name: string;
  role: string;
  bio: string;
  url: string;
  updatedAt: string;
}
