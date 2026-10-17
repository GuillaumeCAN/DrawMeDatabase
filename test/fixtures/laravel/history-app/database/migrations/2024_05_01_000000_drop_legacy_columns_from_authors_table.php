<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('authors', function (Blueprint $table) {
            $table->dropColumn(['legacy_code', 'age']);
            $table->dropSoftDeletes();
            $table->dropRememberToken();
        });
    }

    public function down(): void
    {
        Schema::table('authors', function (Blueprint $table) {
            $table->string('legacy_code');
            $table->bigInteger('age');
            $table->softDeletes();
            $table->rememberToken();
        });
    }
};
