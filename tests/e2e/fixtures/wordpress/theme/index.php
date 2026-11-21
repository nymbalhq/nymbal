<?php
/**
 * One page, built from the query string: the two metas the kit reads, the script tag with the jsDelivr URL, and the
 * Nymbal elements a theme prints. Every value is escaped as a theme would escape a merchant's setting.
 */

$nymbal_param = static function ( string $name ): string {
	return isset( $_GET[ $name ] ) ? sanitize_text_field( wp_unslash( $_GET[ $name ] ) ) : '';
};

$nymbal_api     = $nymbal_param( 'api' );
$nymbal_store   = $nymbal_param( 'store' );
$nymbal_variant = $nymbal_param( 'variant' );
$nymbal_stock   = $nymbal_param( 'stock' );
?>
<!doctype html>
<html <?php language_attributes(); ?>>
<head>
	<meta charset="<?php bloginfo( 'charset' ); ?>" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<?php if ( '' !== $nymbal_api ) : ?>
		<meta name="nymbal:api-url" content="<?php echo esc_url( $nymbal_api ); ?>" />
	<?php endif; ?>
	<?php if ( '' !== $nymbal_store ) : ?>
		<meta name="nymbal:store-url" content="<?php echo esc_url( $nymbal_store ); ?>" />
	<?php endif; ?>
	<script type="module" src="<?php echo esc_url( 'https://cdn.jsdelivr.net/npm/@nymbalhq/web-components@1.8.0/dist/kit.js' ); ?>"></script>
	<?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
	<header class="site-header">
		<nymbal-mini-cart></nymbal-mini-cart>
	</header>
	<main>
		<div class="product">
			<nymbal-quantity-selector></nymbal-quantity-selector>
			<nymbal-add-to-cart variant-id="<?php echo esc_attr( $nymbal_variant ); ?>"></nymbal-add-to-cart>
		</div>
		<?php if ( '' !== $nymbal_stock ) : ?>
			<nymbal-notify-me variant-id="<?php echo esc_attr( $nymbal_variant ); ?>" stock="<?php echo esc_attr( $nymbal_stock ); ?>"></nymbal-notify-me>
		<?php endif; ?>
	</main>
	<?php wp_footer(); ?>
</body>
</html>
