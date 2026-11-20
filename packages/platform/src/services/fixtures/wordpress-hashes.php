<?php
// Makes wordpress-hashes.json with WordPress's own hashing code, so no vector is Nymbal's idea of the recipe.
//
//   php wordpress-hashes.php <a WordPress release's root> > wordpress-hashes.json && prettier --write wordpress-hashes.json
//
// It loads the release's wp-includes/class-phpass.php and pluggable.php unchanged. apply_filters is the one stub:
// it answers the wp_hash_password_options filter with the cost asked for, as a site's filter would, and passes
// every other value through. Every hash is then checked with that release's wp_check_password.
//
// A password reaches WordPress slashed: wp_magic_quotes (wp-includes/load.php) runs addslashes over $_POST, and
// neither the sign-in (wp_signon, wp-includes/user.php) nor WooCommerce's account, sign-in and reset forms unslash the
// password field. So each hash is made from the typed password as posted, addslashes of it, and checked as
// wp_authenticate checks it: trim, then wp_check_password. A password with a quote, a backslash or a NUL also gets the
// hash of the text as typed, which WordPress itself never signs in through a form.

if ($argc !== 2) {
    fwrite(STDERR, "usage: php wordpress-hashes.php <wordpress root>\n");
    exit(2);
}

define('ABSPATH', rtrim($argv[1], '/') . '/');
define('WPINC', 'wp-includes');

$GLOBALS['nymbal_cost'] = null;

function apply_filters($hook, $value, ...$args)
{
    if ($hook === 'wp_hash_password_options' && $GLOBALS['nymbal_cost'] !== null) {
        return array('cost' => $GLOBALS['nymbal_cost']);
    }
    return $value;
}

require ABSPATH . WPINC . '/version.php';
require_once ABSPATH . WPINC . '/class-phpass.php';
require ABSPATH . WPINC . '/pluggable.php';

/** A password of exactly $bytes bytes, from a repeated phrase. */
function bytes_long($phrase, $bytes)
{
    return substr(str_repeat($phrase, intdiv($bytes, strlen($phrase)) + 1), 0, $bytes);
}

function wp_bcrypt($password, $cost)
{
    $GLOBALS['nymbal_cost'] = $cost;
    $hash = wp_hash_password($password);
    $GLOBALS['nymbal_cost'] = null;
    return $hash;
}

$ascii = 'correct horse battery staple';
$utf8 = "pässwörd-\u{1F98A}-ünïcode";
$short = 'tiny5';

$made = array(
    array('phpass ascii', 'phpass', null, $ascii, true),
    array('phpass utf-8', 'phpass', null, $utf8, true),
    array('phpass 5 characters', 'phpass', null, $short, true),
    array('phpass 256 bytes', 'phpass', null, bytes_long('phpass-reads-256-', 256), true),
    array('phpass 300 bytes', 'phpass', null, bytes_long('phpass-reads-256-', 300), false),
    array('wp bcrypt 10 ascii', 'wp-bcrypt', 10, $ascii, true),
    array('wp bcrypt 10 utf-8', 'wp-bcrypt', 10, $utf8, true),
    array('wp bcrypt 10 5 characters', 'wp-bcrypt', 10, $short, true),
    array('wp bcrypt 10 100 bytes', 'wp-bcrypt', 10, bytes_long('hmac-keeps-all-100-', 100), true),
    array('wp bcrypt 11 ascii', 'wp-bcrypt', 11, 'eleven rounds of salt', true),
    array('wp bcrypt 12 ascii', 'wp-bcrypt', 12, 'twelve rounds of salt', true),
    array('bcrypt 10 ascii', 'bcrypt', 10, 'plain bcrypt plugin', true),
    array('bcrypt 10 utf-8', 'bcrypt', 10, "pläin-bcrÿpt-\u{1F98A}", true),
    array('bcrypt 11 ascii', 'bcrypt', 11, 'plain bcrypt eleven', true),
);
$slashed = array(
    array('apostrophe', "it's-me"),
    array('double quotes', 'say "hi"'),
    array('backslash', 'back\\slash'),
);
foreach ($slashed as list($what, $typed)) {
    $made[] = array("phpass $what", 'phpass', null, $typed, true);
    $made[] = array("wp bcrypt 10 $what", 'wp-bcrypt', 10, $typed, true);
    $made[] = array("bcrypt 10 $what", 'bcrypt', 10, $typed, true);
}
$made[] = array('wp bcrypt 10 NUL at the end', 'wp-bcrypt', 10, "nul-at-the-end\0", true);

function hash_as($format, $cost, $password)
{
    if ($format === 'phpass') {
        return (new PasswordHash(8, true))->HashPassword($password);
    }
    if ($format === 'wp-bcrypt') {
        return wp_bcrypt($password, $cost);
    }
    return password_hash($password, PASSWORD_BCRYPT, array('cost' => $cost));
}

$vectors = array();
foreach ($made as list($name, $format, $cost, $password, $verifies)) {
    $posted = addslashes($password);
    $hash = hash_as($format, $cost, $posted);
    if (wp_check_password(trim($posted), $hash) !== true || wp_check_password(trim($posted) . 'x', $hash) !== false) {
        fwrite(STDERR, "WordPress does not check its own vector: $name\n");
        exit(1);
    }
    $vector = array(
        'name' => $name,
        'format' => $format,
        'cost' => $cost,
        'password' => $password,
        'posted' => $posted,
        'bytes' => strlen($password),
        'hash' => $hash,
        'nymbalVerifies' => $verifies,
    );
    if ($posted !== $password) {
        $unslashed = hash_as($format, $cost, $password);
        if (wp_check_password(trim($password), $unslashed) !== true || wp_check_password(trim($posted), $unslashed) !== false) {
            fwrite(STDERR, "WordPress does not check the unslashed hash of its own vector: $name\n");
            exit(1);
        }
        $vector['unslashedHash'] = $unslashed;
    }
    $vectors[] = $vector;
}

echo json_encode(
    array(
        'made' => array(
            'by' => 'WordPress ' . $wp_version . ': PasswordHash(8, true)->HashPassword for phpass, wp_hash_password with the wp_hash_password_options filter answering the cost for wp bcrypt, and PHP password_hash for plain bcrypt (what a bcrypt plugin writes), each of the password as posted (addslashes, as wp_magic_quotes slashes $_POST); each checked with wp_check_password of the trimmed posted password',
            'wordpress' => $wp_version,
            'php' => PHP_VERSION,
            'command' => 'php wordpress-hashes.php <wordpress-' . $wp_version . ' root> > wordpress-hashes.json && prettier --write wordpress-hashes.json',
            'nymbalVerifies' => 'false only where Nymbal refuses what WordPress accepts: phpass over 256 bytes',
            'unslashedHash' => 'the same recipe over the password as typed, which WordPress does not sign in through a form',
        ),
        'vectors' => $vectors,
    ),
    JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
) . "\n";
