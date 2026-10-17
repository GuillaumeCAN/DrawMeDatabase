<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::rename('authors', 'writers');
        Schema::dropIfExists('temp_imports');
        Schema::drop('legacy_logs');

        Schema::table('writers', function (Blueprint $table) {
            $table->string('country', 2)->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('writers', function (Blueprint $table) {
            $table->dropColumn('country');
        });
        Schema::create('legacy_logs', function (Blueprint $table) {
            $table->string('line');
        });
        Schema::rename('writers', 'authors');
    }
};
