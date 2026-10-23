import * as cheerio from 'cheerio';

/** Synthetic server storage for existing happy-path form fixtures. */
export function saveForm(html: string, body: string | null): string {
  const $ = cheerio.load(html);
  const fields = new URLSearchParams(body || '');
  $('input[name], select[name]').each((_, el) => {
    const field = $(el);
    const value = fields.get(field.attr('name')!);
    if (value === null) return;
    if (field.is('select')) {
      field.find('option').each((__, option) => {
        $(option).removeAttr('selected');
        if ($(option).attr('value') === value) $(option).attr('selected', 'selected');
      });
    } else {
      field.attr('value', value);
    }
  });
  return $.html();
}
