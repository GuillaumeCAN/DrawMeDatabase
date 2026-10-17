<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('posts', fn (Blueprint $table) => $table->string('subtitle')->nullable()->after('title'));

        Schema::table('posts', function (Blueprint $table) {
            $table->after('title', function (Blueprint $table) {
                $table->string('excerpt');
                $table->string('cover');
            });
            $table->string('canonical_url')->nullable();
        });

        Schema::connection('mysql')->create('audits', function (Blueprint $table) {
            $table->id();
            $table->morphs('auditable');
            $table->nullableUuidMorphs('causer');
        });

        Schema::withoutForeignKeyConstraints(function () {
            Schema::create('settings', function (Blueprint $table) {
                $table->string('key')->primary();
                $table->json('value');
            });
        });

        if (! Schema::hasTable('flags')) {
            Schema::create('flags', function (Blueprint $table) {
                $table->ulid('id')->primary();
                $table->boolean('enabled')->default(false);
            });
        }

        DB::statement(<<<'SQL'
            -- Schema::create('fake_table', function (Blueprint $table) {});
            CREATE VIEW published_posts AS SELECT * FROM posts WHERE status = 'published'
            SQL);
    }

    public function down(): void
    {
        DB::statement('DROP VIEW published_posts');
        Schema::dropIfExists('flags');
        Schema::dropIfExists('settings');
        Schema::dropIfExists('audits');
        Schema::table('posts', function (Blueprint $table) {
            $table->dropColumn(['subtitle', 'excerpt', 'cover', 'canonical_url']);
        });
    }
};
