<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('awards', function (Blueprint $table) {
            $table->id();
            $table->foreignId('writer_id')->constrained()->cascadeOnDelete();
            $table->foreignId('book_id')->nullable()->constrained()->nullOnDelete();
            $table->string('title');
            $table->year('year');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('awards');
    }
};
