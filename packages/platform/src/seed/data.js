export const seedCategories = [
    {
        slug: 'apparel',
        name: 'Apparel',
        description: 'Everyday clothing and accessories',
    },
    { slug: 'home', name: 'Home', description: 'Homeware, decor, and kitchen essentials' },
    {
        slug: 'electronics',
        name: 'Electronics',
        description: 'Gadgets, audio, and computing accessories',
    },
    { slug: 'books', name: 'Books', description: 'Fiction, non-fiction, and reference' },
];
function img(seed) {
    return `https://picsum.photos/seed/${encodeURIComponent(seed)}/600/600`;
}
export const seedProducts = [
    // Apparel — 6
    { slug: 'merino-crew', title: 'Merino Crew Sweater', description: 'Midweight merino wool, unisex fit.', priceMinor: 8900, categorySlug: 'apparel', imageUrl: img('merino-crew') },
    { slug: 'organic-tee', title: 'Organic Cotton Tee', description: 'Heavyweight organic cotton, pre-washed.', priceMinor: 2400, categorySlug: 'apparel', imageUrl: img('organic-tee') },
    { slug: 'selvedge-denim', title: 'Selvedge Denim Jeans', description: '14oz Japanese selvedge, straight leg.', priceMinor: 14500, categorySlug: 'apparel', imageUrl: img('selvedge-denim') },
    { slug: 'runner-socks', title: 'Runner Socks (3-pack)', description: 'Moisture-wicking, cushioned heel.', priceMinor: 1800, categorySlug: 'apparel', imageUrl: img('runner-socks') },
    { slug: 'wool-beanie', title: 'Ribbed Wool Beanie', description: 'Hand-knit in Scotland, one size.', priceMinor: 3200, categorySlug: 'apparel', imageUrl: img('wool-beanie') },
    { slug: 'leather-belt', title: 'Bridle Leather Belt', description: 'Full-grain English bridle leather.', priceMinor: 6500, categorySlug: 'apparel', imageUrl: img('leather-belt') },
    // Home — 6
    { slug: 'ceramic-mug', title: 'Stoneware Mug', description: 'Hand-thrown stoneware, 350ml.', priceMinor: 1900, categorySlug: 'home', imageUrl: img('ceramic-mug') },
    { slug: 'linen-sheets', title: 'Washed Linen Sheet Set', description: 'French linen, stonewashed for softness.', priceMinor: 17900, categorySlug: 'home', imageUrl: img('linen-sheets') },
    { slug: 'cast-iron-pan', title: 'Cast Iron Skillet 12"', description: 'Pre-seasoned, made in the USA.', priceMinor: 7900, categorySlug: 'home', imageUrl: img('cast-iron-pan') },
    { slug: 'soy-candle', title: 'Soy Candle — Fig & Cedar', description: 'Hand-poured, 50hr burn time.', priceMinor: 3400, categorySlug: 'home', imageUrl: img('soy-candle') },
    { slug: 'walnut-board', title: 'Walnut Cutting Board', description: 'End-grain walnut, oiled finish.', priceMinor: 8900, categorySlug: 'home', imageUrl: img('walnut-board') },
    { slug: 'wool-throw', title: 'Lambswool Throw', description: 'Welsh-woven lambswool, 130×180cm.', priceMinor: 11500, categorySlug: 'home', imageUrl: img('wool-throw') },
    // Electronics — 6
    { slug: 'wireless-earbuds', title: 'Wireless Earbuds', description: 'Active noise cancellation, 30hr case.', priceMinor: 14900, categorySlug: 'electronics', imageUrl: img('wireless-earbuds') },
    { slug: 'mechanical-keyboard', title: '75% Mechanical Keyboard', description: 'Hot-swap switches, PBT keycaps.', priceMinor: 16500, categorySlug: 'electronics', imageUrl: img('mechanical-keyboard') },
    { slug: 'portable-ssd', title: 'Portable SSD 1TB', description: 'USB-C, 1050MB/s read.', priceMinor: 11900, categorySlug: 'electronics', imageUrl: img('portable-ssd') },
    { slug: 'desk-lamp', title: 'Bias Desk Lamp', description: 'Tunable white, monitor-friendly glare shield.', priceMinor: 9800, categorySlug: 'electronics', imageUrl: img('desk-lamp') },
    { slug: 'usb-c-hub', title: '7-in-1 USB-C Hub', description: 'HDMI 4K60, 100W PD pass-through.', priceMinor: 5900, categorySlug: 'electronics', imageUrl: img('usb-c-hub') },
    { slug: 'bluetooth-speaker', title: 'Portable Bluetooth Speaker', description: 'IPX7 waterproof, 20hr battery.', priceMinor: 8900, categorySlug: 'electronics', imageUrl: img('bluetooth-speaker') },
    // Books — 6
    { slug: 'designing-data-intensive-applications', title: 'Designing Data-Intensive Applications', description: 'Martin Kleppmann’s canonical guide to modern data systems.', priceMinor: 3600, categorySlug: 'books', imageUrl: img('ddia') },
    { slug: 'the-pragmatic-programmer', title: 'The Pragmatic Programmer (20th anniversary)', description: 'Hunt & Thomas on the craft of software.', priceMinor: 3200, categorySlug: 'books', imageUrl: img('pragprog') },
    { slug: 'shape-up', title: 'Shape Up', description: 'Stop running in circles — ship work that matters.', priceMinor: 2500, categorySlug: 'books', imageUrl: img('shapeup') },
    { slug: 'the-manager-path', title: 'The Manager’s Path', description: 'Camille Fournier on engineering leadership.', priceMinor: 2800, categorySlug: 'books', imageUrl: img('manager-path') },
    { slug: 'accelerate', title: 'Accelerate', description: 'The science of lean software and DevOps.', priceMinor: 2400, categorySlug: 'books', imageUrl: img('accelerate') },
    { slug: 'working-effectively-with-legacy-code', title: 'Working Effectively with Legacy Code', description: 'Michael Feathers on rescuing complex codebases.', priceMinor: 3400, categorySlug: 'books', imageUrl: img('legacy-code') },
];
//# sourceMappingURL=data.js.map