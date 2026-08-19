/** Sample stores + menus used only in preview mode (no Supabase configured). */

export interface SampleStore {
  id: string;
  name: string;
  category: string;
  items: { id: string; name: string; price: number; description?: string }[];
}

export const SAMPLE_STORES: SampleStore[] = [
  {
    id: 'store-lutong',
    name: 'Lutong Bahay Carinderia',
    category: 'Filipino',
    items: [
      { id: 'i-adobo', name: 'Chicken Adobo', price: 95, description: 'with rice' },
      { id: 'i-sinigang', name: 'Pork Sinigang', price: 120 },
      { id: 'i-rice', name: 'Extra Rice', price: 20 },
    ],
  },
  {
    id: 'store-brew',
    name: 'Barrio Brew',
    category: 'Milk tea & coffee',
    items: [
      { id: 'i-wintermelon', name: 'Wintermelon Milk Tea', price: 90 },
      { id: 'i-americano', name: 'Iced Americano', price: 75 },
    ],
  },
  {
    id: 'store-pharma',
    name: 'Botica Central',
    category: 'Pharmacy',
    items: [
      { id: 'i-paracetamol', name: 'Paracetamol (10 tabs)', price: 45 },
      { id: 'i-vitc', name: 'Vitamin C (bottle)', price: 130 },
    ],
  },
];
