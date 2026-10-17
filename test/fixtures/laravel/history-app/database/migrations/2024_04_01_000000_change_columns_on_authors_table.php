<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('authors', function (Blueprint $table) {
            $table->text('bio')->nullable()->change();
            $table->bigInteger('age')
                ->unsigned()
                ->change();
            // Since Laravel 11, change() must repeat every modifier: phone is no longer nullable
            $table->string('phone', 32)->change();
        });
    }

    public function down(): void
    {
        Schema::table('authors', function (Blueprint $table) {
            $table->string('bio')->change();
            $table->integer('age')->change();
            $table->string('phone')->nullable()->change();
        });
    }
};
