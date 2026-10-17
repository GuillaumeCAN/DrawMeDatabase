<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create("users", static function (Blueprint $t): void {
            $t->id();
            $t->string("email")->unique();
            // $t->string('old_username');
            # $t->string('hash_comment');
            /* $t->integer('karma'); */
            $t->string('name'); // see issue #12 });
            $t->string('nickname');
        });

        /*
        Schema::create('ghost_table', function (Blueprint $table) {
            $table->string('boo');
        });
        */

        Schema::create('posts', function ($table) use ($connection) {
            $table->id();
            $table->foreignId("user_id")->constrained("users");
            $table->string('title')->comment('Shown as $table->title() }); in lists');
            $table->string('currency', 3)->default('$');
            $table->string('token', 64)->default('$&');
            $table->string('suffix', 10)->default("$'");
            $table->text('summary')->default('</script><img src=x onerror="alert(1)">');
            $table->decimal('price',8,2);
            $table->string( 'spaced' );
            $table->enum('status', [
                'draft',
                'published',
            ])->default('draft');
            $table->string('a', 10); $table->string('b', 20);
            $table->DateTime('reviewed_at')->nullable();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('posts');
        Schema::dropIfExists('users');
    }
};
